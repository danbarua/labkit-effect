/**
 * A context assembler that offers the model a catalog of tools, and sends the turn so far: its
 * inputs, the model's responses with their tool calls, the tools' outcomes, and input given to the
 * turn between steps. Earlier turns are not sent.
 */

import { Effect, Layer } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import type { TurnId } from "../agent-core/names.ts";
import { ContextAssembler, type ModelContext, type ToolSpec } from "./contracts.ts";
import { conversationOf } from "./conversation.ts";

/** The facts from the start of `turn` onwards. */
function turnFacts(facts: ReadonlyArray<Fact>, turn: TurnId): ReadonlyArray<Fact> {
  const start = facts.findIndex(
    (fact) => fact._tag === "Observed" && fact.observation._tag === "TurnStarted" && fact.observation.turn === turn,
  );
  return start === -1 ? [] : facts.slice(start);
}

export const ToolContextAssembler = (catalog: ReadonlyArray<ToolSpec>) =>
  Layer.succeed(ContextAssembler, {
    assemble: (facts, turn) => {
      const context: ModelContext = {
        system: undefined,
        tools: catalog,
        messages: conversationOf(turnFacts(facts, turn), facts),
      };
      return Effect.succeed(context);
    },
  });
