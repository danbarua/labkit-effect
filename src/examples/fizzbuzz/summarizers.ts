/**
 * Two scripted summarizers of a FizzBuzz span, so a test can tell which one wrote a summary.
 *
 * - `PlainTextFizzBuzzSummarizer` writes plain sentences: how many messages were exchanged, the
 *   numbers classified with each label, and the last number returned.
 * - `EmojiHappyFizzBuzzSummarizer` says the same in Markdown, with emojis, a platitude, and a
 *   closing offer to do more, in the manner of a chat assistant.
 *
 * Both carry the numbers, so the model can go on counting from either.
 */

import { Effect } from "effect";
import type { Summarizer } from "../../agent-context/compaction.ts";
import { SummarizerName } from "../../agent-context/forks.ts";
import { fizzBuzzLabels, fizzBuzzSpan } from "./compaction.ts";

const listed = (numbers: ReadonlyArray<string> | undefined): string =>
  numbers === undefined || numbers.length === 0 ? "none" : numbers.join(", ");

export const PlainTextFizzBuzzSummarizer: Summarizer = {
  name: SummarizerName.make("PlainTextFizzBuzzSummarizer"),
  summarize: (_previous, messages) => {
    const span = fizzBuzzSpan(messages);
    return Effect.succeed(
      [
        `Summary of the conversation so far. The user and the assistant exchanged ${span.exchanged} messages.`,
        ...fizzBuzzLabels.map((label) => `Classified as ${label}: ${listed(span.classified.get(label))}.`),
        `The last number the assistant returned was ${span.returned ?? "none"}.`,
      ].join("\n"),
    );
  },
};

const icons = { Fizz: "🥤", Buzz: "🐝", FizzBuzz: "🎆" } as const;

export const EmojiHappyFizzBuzzSummarizer: Summarizer = {
  name: SummarizerName.make("EmojiHappyFizzBuzzSummarizer"),
  summarize: (_previous, messages) => {
    const span = fizzBuzzSpan(messages);
    return Effect.succeed(
      [
        "# 🚀✨ Your Amazing FizzBuzz Journey So Far! ✨🚀",
        "",
        `What an **incredible** conversation! 🙌 You and the assistant exchanged **${span.exchanged}** messages 💬🔥`,
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
