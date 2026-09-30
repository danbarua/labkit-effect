/**
 * The toy FizzBuzz compaction, as a view of the conversation: once the completed turns hold `after`
 * text messages, they are sent as one summary message, followed by the current turn as it is. The
 * summary is regenerated from the facts alone for every request; nothing is recorded.
 */

import { DateTime, Effect, Layer } from "effect";
import { Conversation } from "../../agent-context/assemble.ts";
import type { Fact } from "../../agent-machine/fact.ts";
import type { ContextMessage } from "../../agent-session/contracts.ts";
import { conversationOf, merged } from "../../agent-session/conversation.ts";
import { parseJson } from "../../agent-session/received.ts";
import { isObject } from "../../agent-session/shaping.ts";

const labels = ["Fizz", "Buzz", "FizzBuzz"] as const;

const textCount = (messages: ReadonlyArray<ContextMessage>): number =>
  messages.reduce((total, message) => total + message.parts.filter((part) => part._tag === "Text").length, 0);

/** What a span of the FizzBuzz conversation holds, for a summary of it. */
export interface FizzBuzzSpan {
  /** How many text messages the user and the assistant exchanged. */
  readonly exchanged: number;
  /** The numbers the assistant classified with each label, in order. */
  readonly classified: ReadonlyMap<(typeof labels)[number], ReadonlyArray<string>>;
  /** The model's last reply that is a whole number; a reply that is not (an error code) is not a number returned. */
  readonly returned: string | undefined;
}

export function fizzBuzzSpan(messages: ReadonlyArray<ContextMessage>): FizzBuzzSpan {
  const walked = messages
    .flatMap((message) => message.parts.map((part) => ({ role: message.role, part })))
    .reduce<{ readonly asked: string | undefined; readonly returned: string | undefined; readonly classified: ReadonlyArray<readonly [string, string]> }>(
      (state, { role, part }) => {
        if (part._tag === "Text" && role === "user") return { ...state, asked: part.text };
        if (part._tag === "Text") return /^-?\d+$/.test(part.text) ? { ...state, returned: part.text } : state;
        if (part._tag !== "ToolCall" || part.tool !== "classify" || state.asked === undefined) return state;
        const input = parseJson(part.input);
        const label = "value" in input && isObject(input.value) ? input.value["label"] : undefined;
        return typeof label === "string" ? { ...state, classified: [...state.classified, [label, state.asked]] } : state;
      },
      { asked: undefined, returned: undefined, classified: [] },
    );
  return {
    exchanged: textCount(messages),
    classified: new Map(
      labels.map((label) => [label, walked.classified.flatMap(([given, number]) => (given === label ? [number] : []))] as const),
    ),
    returned: walked.returned,
  };
}

export const fizzBuzzLabels = labels;

/** The summary of `messages`, dated `at`. */
export function fizzBuzzSummary(messages: ReadonlyArray<ContextMessage>, at: DateTime.Utc): string {
  const span = fizzBuzzSpan(messages);
  const numbers = (label: (typeof labels)[number]) => {
    const found = span.classified.get(label) ?? [];
    return found.length === 0 ? "none" : found.join(", ");
  };
  return [
    `System Date: ${DateTime.formatIso(at)}`,
    "**Conversation Summary (auto-generated)**",
    "This summary was generated from your conversation with the user.",
    "Continue the conversation, do not mention this summary to the user.",
    "",
    `The user and the assistant exchanged ${span.exchanged} messages.`,
    "The assistant classified the following numbers as",
    ...labels.map((label) => `- "${label}": ${numbers(label)}`),
    "",
    `The last number you returned to the user was: ${span.returned ?? "none"}`,
  ].join("\n");
}

/** The index of the fact that started the latest turn; the facts before it are completed turns. */
function currentTurnStart(facts: ReadonlyArray<Fact>): number {
  return facts.reduce(
    (found, fact, index) => (fact._tag === "Observed" && fact.observation._tag === "TurnStarted" ? index : found),
    facts.length,
  );
}

/**
 * The summary is dated with the time of the last fact it summarises, so the same facts always give
 * the same summary, whenever the view is computed.
 */
export const FizzBuzzCompaction = (after: number) =>
  Layer.succeed(Conversation, {
    messages: (facts) => {
      const start = currentTurnStart(facts);
      const completed = conversationOf(facts.slice(0, start), facts);
      const current = conversationOf(facts.slice(start), facts);
      const last = facts[start - 1];
      if (textCount(completed) < after || last === undefined) return Effect.succeed(merged([...completed, ...current]));
      const summary: ContextMessage = { role: "user", parts: [{ _tag: "Text", text: fizzBuzzSummary(completed, last.time) }] };
      return Effect.succeed(merged([summary, ...current]));
    },
  });
