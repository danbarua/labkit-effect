/** The scripted FizzBuzz summarizers: what each writes of a span. */

import { expect } from "bun:test";
import { Effect } from "effect";
import { ModelName, ProviderName } from "../../agent-machine/names.ts";
import type { ContextMessage } from "../../agent-session/contracts.ts";
import { asText } from "../../agent-session/received.ts";
import { test } from "../../../tests/support/test.ts";
import { EmojiHappyFizzBuzzSummarizer, PlainTextFizzBuzzSummarizer } from "./summarizers.ts";

const said = (role: "user" | "assistant", text: string): ContextMessage => ({ role, parts: [{ _tag: "Text", text }] });

test.each([
  ["PlainTextFizzBuzzSummarizer", PlainTextFizzBuzzSummarizer],
  ["EmojiHappyFizzBuzzSummarizer", EmojiHappyFizzBuzzSummarizer],
])("%s writes the line the scripted model reads the last number from", (_, summarizer) => {
  const target = { provider: ProviderName.make("scripted"), model: ModelName.make("fizzbuzz-1") };
  const summary = Effect.runSync(
    summarizer.summarize([], [said("user", "1"), said("assistant", "2"), said("user", "6"), said("assistant", "7")], target, { system: undefined, tools: [] }),
  );
  expect(asText(summary).split("\n")).toContain("The last number you returned to the user was: 7");
});
