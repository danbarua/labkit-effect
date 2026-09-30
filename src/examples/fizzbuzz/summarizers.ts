/**
 * Two scripted summarizers of a FizzBuzz span, so a test can tell which one wrote a summary.
 *
 * - `PlainTextFizzBuzzSummarizer` writes plain sentences about the span since the last summary: how
 *   many messages were exchanged in it, the numbers classified with each label, and the last number
 *   returned.
 * - `EmojiHappyFizzBuzzSummarizer` says the same in Markdown, with emojis, a platitude, and a
 *   closing offer to do more, in the manner of a chat assistant.
 *
 * Both carry the numbers, so the model can go on counting from either.
 */

import { Effect } from "effect";
import type { Summarizer } from "../../agent-context/compaction.ts";
import { SummarizerName, type WindowSummary } from "../../agent-context/forks.ts";
import { fizzBuzzLabels, fizzBuzzSpan } from "./compaction.ts";

/** Where the span starts: after the summary before it, or at the start of the conversation. */
const since = (previous: ReadonlyArray<WindowSummary>): string =>
  previous.length === 0 ? "since it began" : "since the last summary";

const listed = (numbers: ReadonlyArray<string> | undefined): string =>
  numbers === undefined || numbers.length === 0 ? "none" : numbers.join(", ");

export const PlainTextFizzBuzzSummarizer: Summarizer = {
  name: SummarizerName.make("PlainTextFizzBuzzSummarizer"),
  summarize: (previous, messages) => {
    const span = fizzBuzzSpan(messages);
    return Effect.succeed(
      [
        `Summary of the conversation ${since(previous)}. The user and the assistant exchanged ${span.exchanged} messages in it.`,
        ...fizzBuzzLabels.map((label) => `Classified as ${label}: ${listed(span.classified.get(label))}.`),
        `The last number the assistant returned was ${span.returned ?? "none"}.`,
      ].join("\n"),
    );
  },
};

const icons = { Fizz: "🥤", Buzz: "🐝", FizzBuzz: "🎆" } as const;

export const EmojiHappyFizzBuzzSummarizer: Summarizer = {
  name: SummarizerName.make("EmojiHappyFizzBuzzSummarizer"),
  summarize: (previous, messages) => {
    const span = fizzBuzzSpan(messages);
    return Effect.succeed(
      [
        "# 🚀✨ Your Amazing FizzBuzz Journey! ✨🚀",
        "",
        `What an **incredible** stretch of conversation! 🙌 ${since(previous)}, you and the assistant exchanged **${span.exchanged}** messages 💬🔥`,
        "",
        "## 🏆 Highlights",
        ...fizzBuzzLabels.map((label) => `- ${icons[label]} **${label}**: ${listed(span.classified.get(label))} 💯`),
        "",
        `> 🎯 The last number returned was **${span.returned ?? "none"}**! 🎉`,
        "",
        "Remember: every number is a step on the path to greatness! 🌈💪",
        "",
        "Would you like me to turn this into a colourful chart of your FizzBuzz progress? 📊😊",
      ].join("\n"),
    );
  },
};
