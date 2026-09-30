/**
 * The conversation as the model is sent it, projected from facts: each input given to a turn is a
 * user message, each response an assistant message with its text and tool calls, followed by a
 * user message with a result for every call it made, each notice an instruction message where it
 * was inserted. Consecutive messages from one role become one.
 *
 * A response's thinking and the parts the harness does not recognise stay in their place, marked
 * with the provider that produced them; which provider reads them is its adapter's business.
 */

import type { Fact } from "../agent-core/fact.ts";
import type { CallId, NoticeText, Seq } from "../agent-core/names.ts";
import type { ToolOutcome } from "../agent-core/observation.ts";
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

/** Notices, as the instruction message the model is sent them in. */
export function noticeMessage(notices: ReadonlyArray<NoticeText>): ContextMessage {
  return { role: "instruction", parts: notices.map((text) => ({ _tag: "Text", text })) };
}

/** How each tool call ended, as far as the facts say, and which calls began to run. */
interface Calls {
  readonly ended: ReadonlyMap<CallId, ToolOutcome>;
  readonly dispatched: ReadonlySet<CallId>;
}

function callsOf(facts: ReadonlyArray<Fact>): Calls {
  const observed = facts.flatMap((fact) => (fact._tag === "Observed" ? [fact.observation] : []));
  return {
    ended: new Map(observed.flatMap((each) => (each._tag === "ToolEnded" ? [[each.call, each.outcome] as const] : []))),
    dispatched: new Set(observed.flatMap((each) => (each._tag === "ToolCallDispatched" ? [each.call] : []))),
  };
}

/**
 * How a call ended, for the model. Every call a response made is given a result: the one recorded,
 * or, for a call with none (its turn was interrupted or failed), that how it ended was not observed
 * when it began to run, and that it was not run when it did not.
 */
function outcomeOf(call: CallId, calls: Calls): ToolOutcome {
  return (
    calls.ended.get(call) ?? { _tag: "Failed", reason: { _tag: calls.dispatched.has(call) ? "Indeterminate" : "NotRun" } }
  );
}

/** The messages a fact adds. */
function messages(fact: Fact, texts: ReadonlyMap<Seq, string>, calls: Calls): ReadonlyArray<ContextMessage> {
  const inputs = (seqs: ReadonlyArray<Seq>): ContextMessage => ({
    role: "user",
    parts: seqs.flatMap((seq) => {
      const text = texts.get(seq);
      return text === undefined ? [] : [{ _tag: "Text" as const, text }];
    }),
  });
  if (fact._tag === "Decided") return fact.decision._tag === "InputDelivered" ? [inputs(fact.decision.inputs)] : [];
  const observation = fact.observation;
  switch (observation._tag) {
    case "ModelResponded":
      return [
        {
          role: "assistant",
          parts: observation.parts.flatMap((part): ReadonlyArray<ContextPart> => {
            switch (part._tag) {
              case "Text":
                return [{ _tag: "Text", text: part.text }];
              case "Commentary":
                return [{ _tag: "Commentary", text: part.text }];
              case "ToolCall":
                return [{ _tag: "ToolCall", call: part.call, tool: part.tool, input: part.input }];
              case "Thinking":
                return [{ _tag: "Thinking", provider: observation.provider, text: part.text, received: part.received }];
              case "Unrecognised":
                return [{ _tag: "Unrecognised", provider: observation.provider, received: part.received }];
              default:
                return part satisfies never;
            }
          }),
        },
        // The results follow the response that made the calls, in the order it made them, whenever
        // each tool ended: a call run while its response was still arriving may end before it.
        {
          role: "user",
          parts: observation.parts.flatMap((part): ReadonlyArray<ContextPart> =>
            part._tag === "ToolCall" ? [{ _tag: "ToolResult", call: part.call, outcome: outcomeOf(part.call, calls) }] : [],
          ),
        },
      ];
    case "NoticeInserted":
      return [noticeMessage([observation.text])];
    default:
      return [];
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
 * The messages `facts` add, in order. Input texts and how tool calls ended are looked up in `all`,
 * which defaults to `facts`; pass the whole session when `facts` is part of it.
 */
export function conversationOf(facts: ReadonlyArray<Fact>, all: ReadonlyArray<Fact> = facts): ReadonlyArray<ContextMessage> {
  const texts = inputTexts(all);
  const calls = callsOf(all);
  return merged(facts.flatMap((fact) => messages(fact, texts, calls).filter((added) => added.parts.length > 0)));
}
