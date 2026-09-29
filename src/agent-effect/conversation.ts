/**
 * The conversation as the model is sent it, projected from facts: each input given to a turn is a
 * user message, each response an assistant message with its text and tool calls, each tool's
 * outcome a user message. Consecutive messages from one role become one.
 *
 * A response's thinking and the parts the harness does not recognise stay in their place, marked
 * with the provider that produced them; which provider reads them is its adapter's business.
 */

import type { Fact } from "../agent-core/fact.ts";
import type { Seq } from "../agent-core/names.ts";
import type { ContextMessage, ContextPart } from "./contracts.ts";

/** The text of each input, by its position. */
export function inputTexts(facts: ReadonlyArray<Fact>): ReadonlyMap<Seq, string> {
  return new Map(
    facts.flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "InputArrived"
        ? [[fact.seq, fact.observation.text] as const]
        : [],
    ),
  );
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
              return [{ _tag: "Thinking", provider: observation.provider, text: part.text, signature: part.signature }];
            case "Unrecognised":
              return [{ _tag: "Unrecognised", provider: observation.provider, received: part.received }];
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
export function merged(messages: ReadonlyArray<ContextMessage>): ReadonlyArray<ContextMessage> {
  return messages.reduce<ReadonlyArray<ContextMessage>>((done, next) => {
    const last = done.at(-1);
    return last !== undefined && last.role === next.role
      ? [...done.slice(0, -1), { role: last.role, parts: [...last.parts, ...next.parts] }]
      : [...done, next];
  }, []);
}

/**
 * The messages `facts` add, in order. Input texts are looked up in `all`, which defaults to `facts`;
 * pass the whole session when `facts` is part of it.
 */
export function conversationOf(facts: ReadonlyArray<Fact>, all: ReadonlyArray<Fact> = facts): ReadonlyArray<ContextMessage> {
  const texts = inputTexts(all);
  return merged(
    facts.flatMap((fact) => {
      const added = message(fact, texts);
      return added === undefined || added.parts.length === 0 ? [] : [added];
    }),
  );
}
