/**
 * The loop around the core: it records each observation, asks the core what follows, records the
 * decisions, and carries out the requests, each of whose outcome is the next observation. The
 * session's facts are held in memory.
 */

import { Effect, Ref } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import { decide, fold, initial, type State } from "../agent-core/machine.ts";
import { Seq } from "../agent-core/names.ts";
import type { Observation } from "../agent-core/observation.ts";
import type { EffectRequest } from "../agent-core/request.ts";
import { ContextAssembler, ModelClient, ModelProvider, ToolRunner, Turns } from "./contracts.ts";

interface Held {
  readonly state: State;
  readonly facts: ReadonlyArray<Fact>;
}

type Services = ModelProvider | ContextAssembler | ModelClient | Turns | ToolRunner;

export interface Session {
  /** Records an observation and carries out everything that follows from it. */
  readonly observe: (observation: Observation) => Effect.Effect<void, never, Services>;
  readonly facts: Effect.Effect<ReadonlyArray<Fact>>;
}

export const openSession: Effect.Effect<Session> = Effect.gen(function* () {
  const held = yield* Ref.make<Held>({ state: initial, facts: [] });

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
      });
      yield* Effect.forEach(outcome.requests, (request) =>
        carryOut(request).pipe(Effect.flatMap(observe)),
      );
    });

  return { observe, facts: Ref.get(held).pipe(Effect.map((current) => current.facts)) };
});
