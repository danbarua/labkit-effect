/**
 * A context assembler that offers the model a catalog of tools, and sends the turn so far: its
 * inputs, the model's responses with their tool calls, the tools' outcomes, and input given to the
 * turn between steps. Earlier turns are not sent.
 *
 * Parts the model sent that the harness does not recognise are not sent back.
 */

import { Effect, Layer } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import type { Seq, TurnId } from "../agent-core/names.ts";
import { inputTexts } from "./boring.ts";
import {
  ContextAssembler,
  type ContextMessage,
  type ContextPart,
  type ModelContext,
  type ToolSpec,
} from "./contracts.ts";

/** The facts from the start of `turn` onwards. */
function turnFacts(facts: ReadonlyArray<Fact>, turn: TurnId): ReadonlyArray<Fact> {
  const start = facts.findIndex(
    (fact) => fact._tag === "Observed" && fact.observation._tag === "TurnStarted" && fact.observation.turn === turn,
  );
  return start === -1 ? [] : facts.slice(start);
}

/** The message a fact adds, if any. */
function message(fact: Fact, texts: ReadonlyMap<Seq, string>): ContextMessage | undefined {
  const inputs = (seqs: ReadonlyArray<Seq>): ContextMessage => ({
    role: "user",
    parts: seqs.flatMap((seq) => {
      const text = texts.get(seq);
      return text === undefined ? [] : [{ _tag: "Text" as const, text }];
    }),
  });
  if (fact._tag === "Decided")
    return fact.decision._tag === "InputDelivered" ? inputs(fact.decision.inputs) : undefined;
  const observation = fact.observation;
  switch (observation._tag) {
    case "ModelResponded":
      return {
        role: "assistant",
        parts: observation.parts.flatMap((part): ReadonlyArray<ContextPart> => {
          switch (part._tag) {
            case "Text":
              return [{ _tag: "Text", text: part.text }];
            case "ToolCall":
              return [{ _tag: "ToolCall", call: part.call, tool: part.tool, input: part.input }];
            case "Thinking":
            case "Unrecognised":
              return [];
            default:
              return part satisfies never;
          }
        }),
      };
    case "ToolEnded":
      return { role: "user", parts: [{ _tag: "ToolResult", call: observation.call, outcome: observation.outcome }] };
    default:
      return undefined;
  }
}

/** Consecutive messages from the same role become one. */
function merged(messages: ReadonlyArray<ContextMessage>): ReadonlyArray<ContextMessage> {
  return messages.reduce<ReadonlyArray<ContextMessage>>((done, next) => {
    const last = done.at(-1);
    return last !== undefined && last.role === next.role
      ? [...done.slice(0, -1), { role: last.role, parts: [...last.parts, ...next.parts] }]
      : [...done, next];
  }, []);
}

export const ToolContextAssembler = (catalog: ReadonlyArray<ToolSpec>) =>
  Layer.succeed(ContextAssembler, {
    assemble: (facts, turn) => {
      const texts = inputTexts(facts);
      const context: ModelContext = {
        system: undefined,
        tools: catalog,
        messages: merged(
          turnFacts(facts, turn).flatMap((fact) => {
            const added = message(fact, texts);
            return added === undefined || added.parts.length === 0 ? [] : [added];
          }),
        ),
      };
      return Effect.succeed(context);
    },
  });
