/**
 * Test doubles for the least machinery that runs a turn: one hard-coded provider and model, a
 * context that is the turn's inputs and nothing else, a system prompt and a one-tool catalog.
 */

import { Effect, Layer } from "effect";
import type { SystemPromptProvider, ToolCatalog } from "../../src/agent-context/assemble.ts";
import type { Fact } from "../../src/agent-core/fact.ts";
import { ModelName, ProviderName, type Seq, ToolName, type TurnId } from "../../src/agent-core/names.ts";
import { ContextAssembler, type ModelContext, ModelProvider } from "../../src/agent-effect/contracts.ts";
import { inputTexts } from "../../src/agent-effect/conversation.ts";

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

export const BoringSystemPromptProvider: SystemPromptProvider = {
  system: Effect.succeed(["You are a helpful assistant."]),
};

/** One tool, `echo`, which answers "PONG". */
export const BoringToolCatalog: ToolCatalog = {
  tools: Effect.succeed([
    {
      name: ToolName.make("echo"),
      description: 'Answers "PONG".',
      input: { type: "object", properties: {} },
    },
  ]),
};
