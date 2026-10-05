/**
 * A context assembler that sends only the current turn: its inputs, the model's responses with
 * their tool calls, the tools' outcomes, and input given to the turn between steps. Earlier turns are
 * not sent. Within the turn, a request carries what the previous request carried, as recorded,
 * followed by what the facts since add (`nextMessages`). The system prompt and tools are those that
 * the session's facts record.
 */

import { Effect, Layer } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import type { TurnId } from "../agent-machine/names.ts";
import { ContextAssembler, type ModelContext } from "./contracts.ts";
import { nextMessages } from "./conversation.ts";
import { immutableSystemPromptOf, immutableToolCatalogOf } from "./configuration/session-setup.ts";

/** Returns the facts from the start of `turn` onwards. */
function turnFacts(facts: ReadonlyArray<Fact>, turn: TurnId): ReadonlyArray<Fact> {
  const start = facts.findIndex(
    (fact) => fact._tag === "Observed" && fact.observation._tag === "TurnStarted" && fact.observation.turn === turn,
  );
  return start === -1 ? [] : facts.slice(start);
}

export const TurnContextAssembler = Layer.succeed(ContextAssembler, {
  assemble: (facts, turn) =>
    immutableToolCatalogOf(facts).pipe(
      Effect.map(
        (tools): ModelContext => ({
          system: immutableSystemPromptOf(facts),
          tools,
          messages: nextMessages(turnFacts(facts, turn), facts),
        }),
      ),
    ),
});
