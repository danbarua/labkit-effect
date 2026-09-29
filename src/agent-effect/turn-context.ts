/**
 * A context assembler that sends the turn so far: its inputs, the model's responses with their tool
 * calls, the tools' outcomes, and input given to the turn between steps. Earlier turns are not
 * sent. The system prompt and tools are the ones the session's facts record.
 */

import { Effect, Layer } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import type { TurnId } from "../agent-core/names.ts";
import { ContextAssembler, type ModelContext } from "./contracts.ts";
import { conversationOf } from "./conversation.ts";
import { systemOf, toolsOf } from "./session-setup.ts";

/** The facts from the start of `turn` onwards. */
function turnFacts(facts: ReadonlyArray<Fact>, turn: TurnId): ReadonlyArray<Fact> {
  const start = facts.findIndex(
    (fact) => fact._tag === "Observed" && fact.observation._tag === "TurnStarted" && fact.observation.turn === turn,
  );
  return start === -1 ? [] : facts.slice(start);
}

export const TurnContextAssembler = Layer.succeed(ContextAssembler, {
  assemble: (facts, turn) =>
    toolsOf(facts).pipe(
      Effect.map(
        (tools): ModelContext => ({
          system: systemOf(facts),
          tools,
          messages: conversationOf(turnFacts(facts, turn), facts),
        }),
      ),
    ),
});
