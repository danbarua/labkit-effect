/**
 * The loop around the core: it records each observation, asks the core what follows, records the
 * decisions, and carries out the requests, each of whose outcome is the next observation. The
 * session's facts are held in memory.
 *
 * When a turn starts is decided here: when input arrives and the agent is idle, the loop starts a
 * turn through `Turns` and reports `TurnStarted`.
 *
 * Every log line written while a request is carried out is annotated with what the request is
 * about (its turn, and for a tool run its call and tool), so the services it calls do not pass
 * those along themselves.
 */

import { Effect, Ref } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import { deliver, emptyWorld, type World } from "../agent-core/router.ts";
import { InputText, Seq, type TurnId } from "../agent-core/names.ts";
import type { Observation } from "../agent-core/observation.ts";
import type { EffectRequest } from "../agent-core/request.ts";
import { ContextAssembler, ModelClient, ModelProvider, ToolRunner, TurnEndHooks, Turns } from "./contracts.ts";
import { logKeys } from "./log-keys.ts";

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
}

export const openSession: Effect.Effect<Session> = Effect.gen(function* () {
  const held = yield* Ref.make<Held>({ world: emptyWorld, facts: [], holds: new Map() });

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

  /** What a request is about, for its log lines. */
  const about = (request: EffectRequest, world: World): Record<string, unknown> => {
    const turn = world.agent.state._tag === "Running" ? { turn: world.agent.state.turn } : {};
    switch (request._tag) {
      case "RequestModelResponse":
        return { turn: request.turn };
      case "RunTool":
        return { ...turn, call: request.call, tool: request.tool };
      case "BeforeTurnEnded":
        return { turn: request.turn };
      default:
        return request satisfies never;
    }
  };

  const observe = (observation: Observation): Effect.Effect<void, never, Services> =>
    Effect.gen(function* () {
      const before = yield* Ref.get(held);
      const seq = Seq.make(before.facts.length + 1);
      const outcome = deliver(before.world, seq, observation);
      const recorded: ReadonlyArray<Fact> = [
        { _tag: "Observed", seq, observation },
        ...outcome.decisions.map((decision, index): Fact => ({
          _tag: "Decided",
          seq: Seq.make(seq + 1 + index),
          decision,
        })),
      ];
      yield* Ref.update(held, (now) => ({ ...now, world: outcome.world, facts: [...before.facts, ...recorded] }));
      const after = (yield* Ref.get(held)).world;
      yield* Effect.forEach(outcome.requests, (request) =>
        carryOut(request).pipe(
          Effect.annotateLogs(about(request, after)),
          Effect.flatMap((observations) => Effect.forEach(observations, observe, { discard: true })),
        ),
      );
      if (observation._tag === "InputArrived" && after.agent.state._tag === "Idle") {
        const turn = yield* (yield* Turns).start;
        yield* observe({ _tag: "TurnStarted", turn });
      }
    });

  return { observe, facts: Ref.get(held).pipe(Effect.map((current) => current.facts)) };
});
