/**
 * FizzBuzz with compactions, by the plain text summarizer, then the emoji one, then the plain text
 * one again: when the count reaches 30, 60 and 90 (going on to 94), and after every FizzBuzz
 * (going on to 78).
 */

import { expect } from "bun:test";
import { CompactedConversation } from "../../src/agent-context/compaction.ts";
import type { Fact } from "../../src/agent-machine/fact.ts";
import type { ModelContext } from "../../src/agent-session/contracts.ts";
import { asText } from "../../src/agent-session/received.ts";
import { sentIn } from "../../src/agent-session/sent.ts";
import { afterFizzBuzz, whenCountReaches } from "../../src/examples/fizzbuzz/compaction-policies.ts";
import { basic, countingUser, play } from "../../src/examples/fizzbuzz/scenario.ts";
import { EmojiHappyFizzBuzzSummarizer, PlainTextFizzBuzzSummarizer } from "../../src/examples/fizzbuzz/summarizers.ts";
import { runTest } from "../support/run.ts";
import { test } from "../support/test.ts";

const played = () =>
  runTest(
    play(countingUser(47), {
      ...basic,
      conversation: CompactedConversation,
      compaction: whenCountReaches(
        new Map([
          [30, PlainTextFizzBuzzSummarizer],
          [60, EmojiHappyFizzBuzzSummarizer],
          [90, PlainTextFizzBuzzSummarizer],
        ]),
      ),
    }),
  );

const emoji = /\p{Extended_Pictographic}/u;
const offer = /would you like/i;

/** The requests made, each with whether a window was opened since the request before it. */
function requests(facts: ReadonlyArray<Fact>): ReadonlyArray<{ readonly sent: ModelContext; readonly inNewWindow: boolean }> {
  const state = { opened: false };
  return facts.flatMap((fact) => {
    if (fact._tag === "Decided" && fact.decision._tag === "WindowOpened") state.opened = true;
    if (fact._tag !== "Observed" || fact.observation._tag !== "ModelRequestDispatched") return [];
    const inNewWindow = state.opened;
    state.opened = false;
    return [{ sent: sentIn(fact.observation.sent), inNewWindow }];
  });
}

test("A5: each compaction's summary is recorded with the summarizer that wrote it", async () => {
  const { summaries } = await played();
  expect(summaries.map((each) => [each.window, each.writtenBy]) as unknown).toEqual([
    ["window-1", "PlainTextFizzBuzzSummarizer"],
    ["window-2", "EmojiHappyFizzBuzzSummarizer"],
    ["window-3", "PlainTextFizzBuzzSummarizer"],
  ]);
  const [first, second, third] = summaries.map((each) => asText(each.summary));
  for (const plain of [first, third]) {
    expect(plain).not.toMatch(emoji);
    expect(plain).not.toMatch(offer);
    expect(plain).not.toContain("**");
  }
  expect(second).toMatch(emoji);
  expect(second).toMatch(offer);
  expect(second).toContain("**");
  expect(first).toContain("The last number the assistant returned was 30.");
  expect(second).toContain("The last number returned was **60**");
  expect(third).toContain("The last number the assistant returned was 90.");
  expect(first).toContain("Classified as Fizz: 3, 9, 21, 27.");
  expect(third).toContain("Classified as FizzBuzz: 75.");
});

test("A7: the first request in each window carries every summary so far, as written, and a change of summarizer rewrites none of them", async () => {
  const { facts, summaries } = await played();
  const texts = summaries.map((each) => asText(each.summary));
  const firsts = requests(facts).filter((request) => request.inNewWindow);
  expect(firsts).toHaveLength(3);
  expect(firsts.map((request) => request.sent.messages.slice(0, 2)) as unknown).toEqual([
    [
      { role: "instruction", parts: [{ _tag: "Text", text: texts[0] }] },
      { role: "user", parts: [{ _tag: "Text", text: "31" }] },
    ],
    [
      { role: "instruction", parts: [{ _tag: "Text", text: texts[0] }, { _tag: "Text", text: texts[1] }] },
      { role: "user", parts: [{ _tag: "Text", text: "61" }] },
    ],
    [
      { role: "instruction", parts: [{ _tag: "Text", text: texts[0] }, { _tag: "Text", text: texts[1] }, { _tag: "Text", text: texts[2] }] },
      { role: "user", parts: [{ _tag: "Text", text: "91" }] },
    ],
  ]);
});

test("A6 A7: every other request carries the one before it unchanged, and the model counts on to 94", async () => {
  const { facts, seen } = await played();
  const made = requests(facts);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const carriedOn = made.flatMap((request, at) => {
    const before = made[at - 1];
    if (at === 0 || request.inNewWindow || before === undefined) return [];
    return [before.sent.messages.every((message, index) => same(message, request.sent.messages[index]))];
  });
  expect(carriedOn.length).toBe(made.length - 4);
  expect(carriedOn.every(Boolean)).toBe(true);
  const replies = facts.flatMap((fact) =>
    fact._tag === "Observed" && fact.observation._tag === "ModelResponded"
      ? fact.observation.parts.flatMap((part) => (part._tag === "Text" ? [part.text] : []))
      : [],
  );
  expect(replies as unknown).toEqual(countingUser(47).map((n) => String(Number(n) + 1)));
  expect(seen).toHaveLength(made.length);
});

test("A5 A7: compacting after every FizzBuzz, the summarizer chosen for each, each request in a window carries the summaries as written", async () => {
  const chosen = [PlainTextFizzBuzzSummarizer, EmojiHappyFizzBuzzSummarizer, PlainTextFizzBuzzSummarizer];
  const { facts, summaries } = await runTest(
    play(countingUser(39), {
      ...basic,
      conversation: CompactedConversation,
      compaction: afterFizzBuzz((compacted) => chosen[compacted] ?? PlainTextFizzBuzzSummarizer),
    }),
  );
  expect(summaries.map((each) => each.writtenBy) as unknown).toEqual([
    "PlainTextFizzBuzzSummarizer",
    "EmojiHappyFizzBuzzSummarizer",
    "PlainTextFizzBuzzSummarizer",
  ]);
  const texts = summaries.map((each) => asText(each.summary));
  expect(texts[0]).toContain("The last number the assistant returned was 16.");
  expect(texts[1]).toContain("The last number returned was **46**");
  expect(texts[2]).toContain("The last number the assistant returned was 76.");
  const firsts = requests(facts).filter((request) => request.inNewWindow);
  expect(firsts.map((request) => request.sent.messages.slice(0, 2)) as unknown).toEqual([
    [{ role: "instruction", parts: texts.slice(0, 1).map((text) => ({ _tag: "Text", text })) }, { role: "user", parts: [{ _tag: "Text", text: "17" }] }],
    [{ role: "instruction", parts: texts.slice(0, 2).map((text) => ({ _tag: "Text", text })) }, { role: "user", parts: [{ _tag: "Text", text: "47" }] }],
    [{ role: "instruction", parts: texts.slice(0, 3).map((text) => ({ _tag: "Text", text })) }, { role: "user", parts: [{ _tag: "Text", text: "77" }] }],
  ]);
});
