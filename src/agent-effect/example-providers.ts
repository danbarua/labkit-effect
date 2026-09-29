/**
 * The least machinery that runs a turn: one hard-coded provider and model, a context that is the
 * turn's inputs and nothing else, and turn identities from a counter.
 */

import { Effect, Layer } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import { ModelName, ProviderName, type Seq, TurnId } from "../agent-core/names.ts";
import { ContextAssembler, type ModelContext, ModelProvider, TurnEndHooks, Turns } from "./contracts.ts";
import { inputTexts } from "./conversation.ts";

/** Every request is for provider "boring" and model "boring-1". */
export const BoringModelProvider = Layer.succeed(ModelProvider, {
  select: () => Effect.succeed({ provider: ProviderName.make("boring"), model: ModelName.make("boring-1") }),
});

/** The inputs given to the turn, in order. */
function turnInputs(facts: ReadonlyArray<Fact>, turn: TurnId): ReadonlyArray<Seq> {
  return facts.flatMap((fact) =>
    fact._tag === "Decided" && fact.decision._tag === "InputDelivered" && fact.decision.turn === turn
      ? fact.decision.inputs
      : [],
  );
}

/** No system prompt and no tools; the turn's inputs as one user message. */
export const BoringContextAssembler = Layer.succeed(ContextAssembler, {
  assemble: (facts, turn) => {
    const texts = inputTexts(facts);
    const context: ModelContext = {
      system: undefined,
      tools: [],
      messages: [
        {
          role: "user",
          parts: turnInputs(facts, turn).flatMap((input) => {
            const text = texts.get(input);
            return text === undefined ? [] : [{ _tag: "Text" as const, text }];
          }),
        },
      ],
    };
    return Effect.succeed(context);
  },
});

/** No hooks: a turn ends as soon as it may. */
export const NoTurnEndHooks = Layer.succeed(TurnEndHooks, { hooks: [], maxHolds: 0 });

/** Turn identities `turn-1`, `turn-2`, … in the order turns start. */
export const CountingTurns = Layer.sync(Turns, () => {
  const started = { count: 0 };
  return {
    start: Effect.sync(() => {
      started.count += 1;
      return TurnId.make(`turn-${started.count}`);
    }),
  };
});
