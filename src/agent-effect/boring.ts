/**
 * The least machinery that runs a turn: one hard-coded provider and model, a context that is the
 * turn's inputs and nothing else, and turn identities from a counter.
 */

import { Effect, Layer } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import { ModelName, ProviderName, type Seq, TurnId, type Inputs } from "../agent-core/names.ts";
import { ContextAssembler, type ModelContext, ModelProvider, Turns } from "./contracts.ts";

/** Every request goes to `endpoint`, for provider "boring" and model "boring-1". */
export const BoringModelProvider = (endpoint: URL) =>
  Layer.succeed(ModelProvider, {
    select: () =>
      Effect.succeed({
        provider: ProviderName.make("boring"),
        model: ModelName.make("boring-1"),
        endpoint,
      }),
  });

/** The text of each input, by its position. */
function inputTexts(facts: ReadonlyArray<Fact>): ReadonlyMap<Seq, string> {
  return new Map(
    facts.flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "InputArrived"
        ? [[fact.seq, fact.observation.text] as const]
        : [],
    ),
  );
}

/** The inputs the turn started with. */
function turnInputs(facts: ReadonlyArray<Fact>, turn: TurnId): ReadonlyArray<Seq> {
  return facts.flatMap((fact) =>
    fact._tag === "Observed" && fact.observation._tag === "TurnStarted" && fact.observation.turn === turn
      ? fact.observation.inputs
      : [],
  );
}

/** No system prompt; the turn's inputs as user messages, in order. */
export const BoringContextAssembler = Layer.succeed(ContextAssembler, {
  assemble: (facts, turn) => {
    const texts = inputTexts(facts);
    const context: ModelContext = {
      system: undefined,
      messages: turnInputs(facts, turn).flatMap((input) => {
        const text = texts.get(input);
        return text === undefined ? [] : [{ role: "user" as const, text }];
      }),
    };
    return Effect.succeed(context);
  },
});

/** Turn identities `turn-1`, `turn-2`, … in the order turns start. */
export const CountingTurns = Layer.sync(Turns, () => {
  const started = { count: 0 };
  return {
    start: (_inputs: Inputs) =>
      Effect.sync(() => {
        started.count += 1;
        return TurnId.make(`turn-${started.count}`);
      }),
  };
});
