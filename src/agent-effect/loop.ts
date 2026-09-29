/**
 * The loop around the core: it records each observation, asks the core what follows, records the
 * decisions, and carries out the requests, each of whose outcome is the next observation. The
 * session's facts are held in memory.
 *
 * When a turn starts is decided here: when input arrives and the agent is idle, the loop starts a
 * turn through `Turns` and reports `TurnStarted`.
 *
 * While a request is carried out, `CurrentWork` says what it is about (the session, its turn, and
 * for a tool run its call and tool), and every log line written is annotated with the same, so the
 * services it calls do not pass those along themselves. Each request is carried out in a span named
 * for its kind (`agent.model.request`, `agent.tool.run`, `agent.turn.review`), with the same as its
 * attributes; the observations that follow are recorded outside it.
 *
 * Each fact is published as it is recorded; `subscribe` receives every fact recorded after it.
 */

import { DateTime, Effect, PubSub, Ref, type Scope } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import { deliver, emptyWorld, type World } from "../agent-core/router.ts";
import { InputText, Seq, type TurnId } from "../agent-core/names.ts";
import type { Observation } from "../agent-core/observation.ts";
import type { EffectRequest } from "../agent-core/request.ts";
import { ContextAssembler, ModelClient, ModelProvider, ToolRunner, TurnEndHooks, Turns } from "./contracts.ts";
import { logKeys } from "./log-keys.ts";
import { CurrentWork, type Work } from "./work.ts";

/** The span each kind of request is carried out in. */
const spanNames: Record<EffectRequest["_tag"], string> = {
  RequestModelResponse: "agent.model.request",
  RunTool: "agent.tool.run",
  BeforeTurnEnded: "agent.turn.review",
};

interface Held {
  readonly world: World;
  /** How many times turn-end hooks have held each turn open. */
  readonly holds: ReadonlyMap<TurnId, number>;
  readonly facts: ReadonlyArray<Fact>;
}

type Services = ModelProvider | ContextAssembler | ModelClient | Turns | ToolRunner | TurnEndHooks;

export interface Session {
  /** Records an observation and carries out everything that follows from it. */
  readonly observe: (observation: Observation) => Effect.Effect<void, never, Services>;
  readonly facts: Effect.Effect<ReadonlyArray<Fact>>;
  /** Every fact recorded from now on, in order, for as long as the scope lasts. */
  readonly subscribe: Effect.Effect<PubSub.Subscription<Fact>, never, Scope.Scope>;
}

export const openSession: Effect.Effect<Session> = Effect.gen(function* () {
  const held = yield* Ref.make<Held>({ world: emptyWorld, facts: [], holds: new Map() });
  const recorded = yield* PubSub.unbounded<Fact>();

  /** The turn-end hooks' feedback as input, then the review; after `maxHolds` holds, only the review. */
  const reviewTurnEnd = (turn: TurnId): Effect.Effect<ReadonlyArray<Observation>, never, Services> =>
    Effect.gen(function* () {
      const { hooks, maxHolds } = yield* TurnEndHooks;
      const holds = (yield* Ref.get(held)).holds.get(turn) ?? 0;
      const reviewed = { _tag: "TurnEndReviewed" as const, turn };
      if (hooks.length > 0 && holds >= maxHolds) {
        yield* Effect.logWarning(logKeys.loop.holdsExhausted, { holds, maxHolds });
        return [reviewed];
      }
      const feedback = (yield* Effect.forEach(hooks, (hook) => hook(turn))).flat();
      if (feedback.length === 0) return [reviewed];
      yield* Ref.update(held, (now) => ({ ...now, holds: new Map([...now.holds, [turn, holds + 1]]) }));
      yield* Effect.logInfo(logKeys.loop.turnHeld, { hold: holds + 1, maxHolds, feedback: feedback.length });
      const inputs = feedback.map(
        (text): Observation => ({ _tag: "InputArrived", from: { _tag: "System" }, text: InputText.make(text) }),
      );
      return [...inputs, reviewed];
    });

  const carryOut = (request: EffectRequest): Effect.Effect<ReadonlyArray<Observation>, never, Services> => {
    switch (request._tag) {
      case "RequestModelResponse":
        return Effect.gen(function* () {
          const target = yield* (yield* ModelProvider).select(request.turn);
          const facts = (yield* Ref.get(held)).facts;
          const context = yield* (yield* ContextAssembler).assemble(facts, request.turn);
          return [yield* (yield* ModelClient).respond(target, context, request.turn)];
        });
      case "RunTool":
        return Effect.gen(function* () {
          const outcome = yield* (yield* ToolRunner).run(request.tool, request.input);
          return [{ _tag: "ToolEnded", call: request.call, outcome } as const];
        });
      case "BeforeTurnEnded":
        return reviewTurnEnd(request.turn);
      default:
        return request satisfies never;
    }
  };

  /** What a request is about: the session the facts opened, and the request's turn, call and tool. */
  const about = (request: EffectRequest, world: World, facts: ReadonlyArray<Fact>): Work => {
    const opened = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "SessionOpened");
    const session = opened?._tag === "Observed" && opened.observation._tag === "SessionOpened" ? { session: opened.observation.session } : {};
    const turn = world.agent.state._tag === "Running" ? { turn: world.agent.state.turn } : {};
    switch (request._tag) {
      case "RequestModelResponse":
        return { ...session, turn: request.turn };
      case "RunTool":
        return { ...session, ...turn, call: request.call, tool: request.tool };
      case "BeforeTurnEnded":
        return { ...session, turn: request.turn };
      default:
        return request satisfies never;
    }
  };

  const observe = (observation: Observation): Effect.Effect<void, never, Services> =>
    Effect.gen(function* () {
      const before = yield* Ref.get(held);
      const seq = Seq.make(before.facts.length + 1);
      const outcome = deliver(before.world, seq, observation);
      const time = yield* DateTime.now;
      const facts: ReadonlyArray<Fact> = [
        { _tag: "Observed", seq, time, observation },
        ...outcome.decisions.map((decision, index): Fact => ({
          _tag: "Decided",
          seq: Seq.make(seq + 1 + index),
          time,
          decision,
        })),
      ];
      const now = yield* Ref.updateAndGet(held, (current) => ({
        ...current,
        world: outcome.world,
        facts: [...before.facts, ...facts],
      }));
      yield* PubSub.publishAll(recorded, facts);
      yield* Effect.forEach(outcome.requests, (request) => {
        const work = about(request, now.world, now.facts);
        return carryOut(request).pipe(
          Effect.withSpan(spanNames[request._tag], { attributes: { ...work } }),
          Effect.annotateLogs({ ...work }),
          Effect.provideService(CurrentWork, work),
          Effect.flatMap((observations) => Effect.forEach(observations, observe, { discard: true })),
        );
      });
      const after = now.world;
      if (observation._tag === "InputArrived" && after.agent.state._tag === "Idle") {
        const turn = yield* (yield* Turns).start;
        yield* observe({ _tag: "TurnStarted", turn });
      }
    });

  return {
    observe,
    facts: Ref.get(held).pipe(Effect.map((current) => current.facts)),
    subscribe: PubSub.subscribe(recorded),
  };
});
