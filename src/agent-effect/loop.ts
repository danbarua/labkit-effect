/**
 * The loop around the core: it records each observation, asks the core what follows, records the
 * decisions, and carries out the requests, each of whose outcome is the next observation. The
 * session's facts are held in memory.
 *
 * Every log line written while a request is carried out is annotated with the session and with
 * what the request is about (its turn, and for a tool run its call and tool), so the services it
 * calls do not pass those along themselves.
 */

import { Effect, Ref } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import { decide, fold, initial, type State } from "../agent-core/machine.ts";
import { Seq, type SessionId } from "../agent-core/names.ts";
import type { Observation } from "../agent-core/observation.ts";
import type { EffectRequest } from "../agent-core/request.ts";
import { ContextAssembler, ModelClient, ModelProvider, ToolRunner, Turns } from "./contracts.ts";

interface Held {
  readonly state: State;
  readonly facts: ReadonlyArray<Fact>;
  /** The session's identity, once `SessionOpened` has been observed. */
  readonly session: SessionId | undefined;
}

type Services = ModelProvider | ContextAssembler | ModelClient | Turns | ToolRunner;

export interface Session {
  /** Records an observation and carries out everything that follows from it. */
  readonly observe: (observation: Observation) => Effect.Effect<void, never, Services>;
  readonly facts: Effect.Effect<ReadonlyArray<Fact>>;
}

export const openSession: Effect.Effect<Session> = Effect.gen(function* () {
  const held = yield* Ref.make<Held>({ state: initial, facts: [], session: undefined });

  const carryOut = (request: EffectRequest): Effect.Effect<Observation, never, Services> => {
    switch (request._tag) {
      case "StartTurn":
        return Effect.gen(function* () {
          const turns = yield* Turns;
          const turn = yield* turns.start(request.inputs);
          return { _tag: "TurnStarted", turn, inputs: request.inputs } as const;
        });
      case "RequestModelResponse":
        return Effect.gen(function* () {
          const target = yield* (yield* ModelProvider).select(request.turn);
          const facts = (yield* Ref.get(held)).facts;
          const context = yield* (yield* ContextAssembler).assemble(facts, request.turn);
          return yield* (yield* ModelClient).respond(target, context, request.turn);
        });
      case "RunTool":
        return Effect.gen(function* () {
          const outcome = yield* (yield* ToolRunner).run(request.tool, request.input);
          return { _tag: "ToolEnded", call: request.call, outcome } as const;
        });
      default:
        return request satisfies never;
    }
  };

  /** What a request is about, for its log lines. */
  const about = (request: EffectRequest, now: Held): Record<string, unknown> => {
    const session = now.session === undefined ? {} : { session: now.session };
    const turn =
      now.state._tag === "Open" && now.state.activity._tag === "InTurn" ? { turn: now.state.activity.turn } : {};
    switch (request._tag) {
      case "StartTurn":
        return { ...session, inputs: request.inputs };
      case "RequestModelResponse":
        return { ...session, turn: request.turn };
      case "RunTool":
        return { ...session, ...turn, call: request.call, tool: request.tool };
      default:
        return request satisfies never;
    }
  };

  const observe = (observation: Observation): Effect.Effect<void, never, Services> =>
    Effect.gen(function* () {
      const before = yield* Ref.get(held);
      const seq = Seq.make(before.facts.length + 1);
      const outcome = decide(before.state, seq, observation);
      const recorded: ReadonlyArray<Fact> = [
        { _tag: "Observed", seq, observation },
        ...outcome.decisions.map((decision, index): Fact => ({
          _tag: "Decided",
          seq: Seq.make(seq + 1 + index),
          decision,
        })),
      ];
      yield* Ref.set(held, {
        state: recorded.reduce(fold, before.state),
        facts: [...before.facts, ...recorded],
        session: observation._tag === "SessionOpened" ? observation.session : before.session,
      });
      const after = yield* Ref.get(held);
      yield* Effect.forEach(outcome.requests, (request) =>
        carryOut(request).pipe(Effect.annotateLogs(about(request, after)), Effect.flatMap(observe)),
      );
    });

  return { observe, facts: Ref.get(held).pipe(Effect.map((current) => current.facts)) };
});
