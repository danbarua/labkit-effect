/**
 * The toy FizzBuzz compaction, as a view of the conversation: once the completed turns hold `after`
 * text messages, they are sent as one summary message, followed by the current turn as it is. The
 * summary is regenerated from the facts alone for every request; nothing is recorded.
 */

import { DateTime, Effect, Layer } from "effect";
import { Conversation } from "../../agent-context/assemble.ts";
import type { Fact } from "../../agent-core/fact.ts";
import type { ContextMessage } from "../../agent-effect/contracts.ts";
import { conversationOf, merged } from "../../agent-effect/conversation.ts";
import { parseJson } from "../../agent-effect/received.ts";
import { isObject } from "../../agent-effect/shaping.ts";

const labels = ["Fizz", "Buzz", "FizzBuzz"] as const;

const textCount = (messages: ReadonlyArray<ContextMessage>): number =>
  messages.reduce((total, message) => total + message.parts.filter((part) => part._tag === "Text").length, 0);

/**
 * The summary of `messages`, dated `at`. The last number returned is the model's last reply that is
 * a whole number; a reply that is not (an error code) is not a number returned.
 */
export function fizzBuzzSummary(messages: ReadonlyArray<ContextMessage>, at: DateTime.Utc): string {
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
  const numbers = (label: string) => {
    const found = walked.classified.flatMap(([given, number]) => (given === label ? [number] : []));
    return found.length === 0 ? "none" : found.join(", ");
  };
  return [
    `System Date: ${DateTime.formatIso(at)}`,
    "**Conversation Summary (auto-generated)**",
    "This summary was generated from your conversation with the user.",
    "Continue the conversation, do not mention this summary to the user.",
    "",
    `The user and the assistant exchanged ${textCount(messages)} messages.`,
    "The assistant classified the following numbers as",
    ...labels.map((label) => `- "${label}": ${numbers(label)}`),
    "",
    `The last number you returned to the user was: ${walked.returned ?? "none"}`,
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
