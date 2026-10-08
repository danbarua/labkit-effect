/**
 * The conversation as the model is sent it, projected from facts:
 * - each input given to a turn is a user message;
 * - each response is an assistant message with its text and tool calls, followed by a user message
 *   with a result for every call it made (sent as `tool-output.ts` describes);
 * - each notice is an instruction message, at the place where it was inserted;
 * - each change of the session's working folder or additional folders recorded after TurnZero (the
 *   first `TurnStarted`) is an instruction message saying so, at the place where it was recorded
 *   (`changeTextOf`, `configuration/session-home.ts`). A change recorded before TurnZero is not a
 *   message: the system prompt names the folders that those changes leave.
 *
 * Consecutive messages from one role are merged into one. A response's thinking and the parts that
 * the harness does not recognise stay in their place, marked with the provider that produced them;
 * each provider's adapter decides what to send of them.
 */

import { Array as Arr, Option } from "effect";
import { outcomeAsSent } from "./tool-output.ts";
import type { BlobRef } from "../agent-machine/blob.ts";
import type { Fact } from "../agent-machine/fact.ts";
import type { CallId, NoticeText, Seq } from "../agent-machine/names.ts";
import type { Observation, ToolOutcome } from "../agent-machine/observation.ts";
import type { ContextMessage, ContextPart } from "./contracts.ts";
import { changeTextOf, homeOf, turnZeroOf } from "./configuration/session-home.ts";
import { sentIn } from "./sent.ts";

/** Returns each input's text and its attached files, by the input's sequence number. */
export function inputTexts(facts: ReadonlyArray<Fact>): ReadonlyMap<Seq, { readonly text: string; readonly attachments: ReadonlyArray<BlobRef> }> {
  return new Map(
    facts.flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "InputArrived"
        ? [[fact.seq, { text: fact.observation.text, attachments: fact.observation.attachments ?? [] }] as const]
        : [],
    ),
  );
}

/** Returns `notices` as the instruction message that carries them to the model. */
export function noticeMessage(notices: ReadonlyArray<NoticeText>): ContextMessage {
  return { role: "instruction", parts: notices.map((text) => ({ _tag: "Text", text })) };
}

/** Returns how each tool call ended, as far as the facts record, and which calls began to run. */
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
 * Returns how a call ended, for the model. Every call that a response made gets a result: the one
 * recorded, or, for a call with none (its turn was interrupted or failed), `Indeterminate` when the
 * call began to run and `NotRun` when it did not.
 */
function outcomeOf(call: CallId, calls: Calls): ToolOutcome {
  const ended = calls.ended.get(call);
  return ended === undefined ? { _tag: "Failed", reason: { _tag: calls.dispatched.has(call) ? "Indeterminate" : "NotRun" } } : outcomeAsSent(ended);
}

/** What the messages of a fact are projected with: the inputs' texts, how the calls ended, and the whole session's facts with the position of TurnZero. */
interface Session {
  readonly texts: ReturnType<typeof inputTexts>;
  readonly calls: Calls;
  readonly all: ReadonlyArray<Fact>;
  readonly turnZero: Seq | undefined;
}

/** Returns the message that tells the model of a change of the session's folders recorded at `seq`: none before TurnZero. */
function homeChanged(seq: Seq, change: Parameters<typeof changeTextOf>[0], session: Session): ReadonlyArray<ContextMessage> {
  if (session.turnZero === undefined || seq < session.turnZero) return [];
  return [noticeMessage([changeTextOf(change, homeOf(session.all.filter((fact) => fact.seq < seq)))])];
}

/** Returns the messages that one fact adds to the conversation. */
function messages(fact: Fact, session: Session): ReadonlyArray<ContextMessage> {
  const { texts, calls } = session;
  // Each input is its text, then the files that came with it.
  const inputs = (seqs: ReadonlyArray<Seq>): ContextMessage => ({
    role: "user",
    parts: seqs.flatMap((seq): ReadonlyArray<ContextPart> => {
      const input = texts.get(seq);
      return input === undefined
        ? []
        : [{ _tag: "Text", text: input.text }, ...input.attachments.map((blob): ContextPart => ({ _tag: "File", blob }))];
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
                return [{ _tag: "Thinking", provider: observation.provider, from: { _tag: "Response", model: observation.model, turn: observation.turn }, text: part.text, received: part.received }];
              case "Unrecognised":
                return [{ _tag: "Unrecognised", provider: observation.provider, from: { _tag: "Response", model: observation.model, turn: observation.turn }, received: part.received }];
              default:
                return part satisfies never;
            }
          }),
        },
        // The results follow the response that made the calls, in the order of the calls, whenever
        // each tool ended: a call that ran while its response was still arriving can end before it.
        {
          role: "user",
          parts: observation.parts.flatMap((part): ReadonlyArray<ContextPart> =>
            part._tag === "ToolCall" ? [{ _tag: "ToolResult", call: part.call, outcome: outcomeOf(part.call, calls) }] : [],
          ),
        },
      ];
    case "NoticeInserted":
      return [noticeMessage([observation.text])];
    case "SessionHomed":
    case "FolderAdded":
    case "FolderRemoved":
      return homeChanged(fact.seq, observation, session);
    case "SessionOpened":
    case "InputArrived":
    case "InputCancelled":
    case "TurnStarted":
    case "TurnInterrupted":
    case "TurnEndReviewed":
    case "TurnHoldsExhausted":
    case "ModelRequestDispatched":
    case "ModelAttemptFailed":
    case "ModelFailed":
    case "ModelVetoed":
    case "ModelChangeArrived":
    case "SettingAdjusted":
    case "ToolCallArrived":
    case "ToolCallDispatched":
    case "ToolEnded":
    case "PermissionAsked":
    case "PermissionAnswered":
    case "PermissionFailed":
    case "CompactionWindow":
    case "McpServerChanged":
      return [];
    default:
      return observation satisfies never;
  }
}

/** Merges consecutive messages from the same role into one message. */
export function merged(messages: ReadonlyArray<ContextMessage>): ReadonlyArray<ContextMessage> {
  return messages.reduce<ReadonlyArray<ContextMessage>>((done, next) => {
    const last = done.at(-1);
    return last !== undefined && last.role === next.role
      ? [...done.slice(0, -1), { role: last.role, parts: [...last.parts, ...next.parts] }]
      : [...done, next];
  }, []);
}

/**
 * Returns the messages that `facts` add, in order. Input texts and how tool calls ended are looked
 * up in `all`, which defaults to `facts`; pass the whole session when `facts` is part of it.
 */
export function conversationOf(facts: ReadonlyArray<Fact>, all: ReadonlyArray<Fact> = facts): ReadonlyArray<ContextMessage> {
  const session: Session = { texts: inputTexts(all), calls: callsOf(all), all, turnZero: turnZeroOf(all) };
  return merged(facts.flatMap((fact) => messages(fact, session).filter((added) => added.parts.length > 0)));
}

/**
 * Returns the messages that the next request carries: the messages that the last request in `facts`
 * carried, as recorded with it, followed by the messages of the facts recorded after it. Facts
 * before that request are not projected again, so a change to `conversationOf` changes what later
 * requests add and never what an earlier request carried. With no request in `facts`, returns the
 * messages of all of `facts`. Input texts and how tool calls ended are looked up in `all`, as for
 * `conversationOf`.
 */
export function nextMessages(facts: ReadonlyArray<Fact>, all: ReadonlyArray<Fact> = facts): ReadonlyArray<ContextMessage> {
  const at = Option.getOrElse(Arr.findLastIndex(facts, isRequest), () => -1);
  const request = facts[at];
  if (request === undefined || !isRequest(request)) return conversationOf(facts, all);
  return merged([...sentIn(request.observation.sent).messages, ...conversationOf(facts.slice(at + 1), all)]);
}

type Request = Extract<Fact, { _tag: "Observed" }> & { readonly observation: Extract<Observation, { _tag: "ModelRequestDispatched" }> };

const isRequest = (fact: Fact): fact is Request => fact._tag === "Observed" && fact.observation._tag === "ModelRequestDispatched";
