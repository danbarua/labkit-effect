/**
 * FizzBuzz with compactions, by the plain text summarizer, then the emoji one, then the plain text
 * one again: when the count reaches 30, 60 and 90 (going on to 94), and after every FizzBuzz
 * (going on to 78).
 */

import { expect } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, Layer } from "effect";
import { CompactedConversation } from "../../src/agent-context/compaction.ts";
import { SummariesInFolder } from "../../src/agent-context/summaries-in-folder.ts";
import { ModelName, ProviderName } from "../../src/agent-machine/names.ts";
import { scriptedFizzBuzzModel } from "../../src/examples/fizzbuzz/model.ts";
import type { Fact } from "../../src/agent-machine/fact.ts";
import type { ModelContext } from "../../src/agent-session/contracts.ts";
import { asText, receivedJson } from "../../src/agent-session/received.ts";
import { providerCompaction } from "../../src/agent-context/provider-compaction.ts";
import { json } from "../support/received.ts";
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
  expect(first).toContain("The last number the assistant returned was 28.");
  expect(second).toContain("The last number returned was **58**");
  expect(third).toContain("The last number the assistant returned was 88.");
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
      { role: "user", parts: [{ _tag: "Text", text: "29" }] },
    ],
    [
      { role: "instruction", parts: [{ _tag: "Text", text: texts[0] }, { _tag: "Text", text: texts[1] }] },
      { role: "user", parts: [{ _tag: "Text", text: "59" }] },
    ],
    [
      { role: "instruction", parts: [{ _tag: "Text", text: texts[0] }, { _tag: "Text", text: texts[1] }, { _tag: "Text", text: texts[2] }] },
      { role: "user", parts: [{ _tag: "Text", text: "89" }] },
    ],
  ]);
});

test("A7: a provider's own compaction is sent as its items, to that provider only, in place of the summaries it was made from", async () => {
  const asked: Array<ModelContext> = [];
  const compactions = (_target: unknown, context: ModelContext) =>
    Effect.sync(() => {
      asked.push(context);
      return { output: receivedJson([{ type: "compaction", id: `cmp_${asked.length}`, encrypted_content: "opaque" }]), metadata: receivedJson({}) };
    });
  const byProvider = providerCompaction(compactions);
  const { facts, summaries } = await runTest(
    play(countingUser(47), {
      ...basic,
      conversation: CompactedConversation,
      compaction: whenCountReaches(new Map([[30, PlainTextFizzBuzzSummarizer], [60, byProvider], [90, byProvider]])),
    }),
  );
  const item = (n: number) => ({ _tag: "Unrecognised", provider: "scripted", received: json({ type: "compaction", id: `cmp_${n}`, encrypted_content: "opaque" }) });
  const plain = asText(summaries[0]?.summary ?? receivedJson(null));
  expect(summaries.map((each) => [each.writtenBy, each.summary.mediaType]) as unknown).toEqual([
    ["PlainTextFizzBuzzSummarizer", "text/plain"],
    ["ProviderCompaction", "application/json"],
    ["ProviderCompaction", "application/json"],
  ]);
  // Each compaction is given the provider's summaries before it, then the span since the last one.
  expect(asked.map((context) => context.messages[0]) as unknown).toEqual([
    { role: "instruction", parts: [{ _tag: "Text", text: plain }] },
    { role: "instruction", parts: [item(1)] },
  ]);
  expect(asked[1]?.messages[1] as unknown).toEqual({ role: "user", parts: [{ _tag: "Text", text: "59" }] });
  const firsts = requests(facts).filter((request) => request.inNewWindow);
  expect(firsts.map((request) => request.sent.messages.slice(0, 2)) as unknown).toEqual([
    [{ role: "instruction", parts: [{ _tag: "Text", text: plain }] }, { role: "user", parts: [{ _tag: "Text", text: "29" }] }],
    [{ role: "instruction", parts: [item(1)] }, { role: "user", parts: [{ _tag: "Text", text: "59" }] }],
    [{ role: "instruction", parts: [item(2)] }, { role: "user", parts: [{ _tag: "Text", text: "89" }] }],
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
  expect(texts[0]).toContain("The last number the assistant returned was 14.");
  expect(texts[1]).toContain("The last number returned was **44**");
  expect(texts[2]).toContain("The last number the assistant returned was 74.");
  const firsts = requests(facts).filter((request) => request.inNewWindow);
  expect(firsts.map((request) => request.sent.messages.slice(0, 2)) as unknown).toEqual([
    [{ role: "instruction", parts: texts.slice(0, 1).map((text) => ({ _tag: "Text", text })) }, { role: "user", parts: [{ _tag: "Text", text: "15" }] }],
    [{ role: "instruction", parts: texts.slice(0, 2).map((text) => ({ _tag: "Text", text })) }, { role: "user", parts: [{ _tag: "Text", text: "45" }] }],
    [{ role: "instruction", parts: texts.slice(0, 3).map((text) => ({ _tag: "Text", text })) }, { role: "user", parts: [{ _tag: "Text", text: "75" }] }],
  ]);
});

const provider = (name: string, model: string) => ({ provider: ProviderName.make(name), model: ModelName.make(model) });

test("A5 A8: switching provider, each is sent its own summaries, and a switch back goes on from where it was", async () => {
  const folder = mkdtempSync(join(tmpdir(), "summaries-"));
  const policy = whenCountReaches(
    new Map([
      [8, PlainTextFizzBuzzSummarizer],
      [16, EmojiHappyFizzBuzzSummarizer],
    ]),
  );
  const { facts, summaries } = await runTest(
    play(countingUser(10), {
      ...basic,
      model: { target: provider("anthropic", "claude-fizz"), client: scriptedFizzBuzzModel().layer },
      conversation: CompactedConversation,
      compaction: policy,
      switches: new Map([
        [8, provider("openai", "gpt-fizz")],
        [16, provider("anthropic", "claude-fizz")],
      ]),
      summaries: SummariesInFolder(folder).pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
    }),
  );
  // Written for the provider that was being asked, from where that provider's summaries end.
  expect(summaries.map((each) => [each.window, each.kind, each.writtenBy]) as unknown).toEqual([
    ["window-1", "anthropic", "PlainTextFizzBuzzSummarizer"],
    ["window-2", "openai", "EmojiHappyFizzBuzzSummarizer"],
  ]);
  const [plain, emoji] = summaries.map((each) => asText(each.summary));
  expect(plain).toContain("exchanged 6 messages");
  expect(emoji).toContain("since it began, you and the assistant exchanged **14** messages");
  // Kept as files, one folder for each kind, and read back as written.
  expect(readdirSync(join(folder, "fizzbuzz")).sort()).toEqual(["anthropic", "openai"]);
  expect(readdirSync(join(folder, "fizzbuzz", "openai"))[0]).toMatch(/^0001_\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z_EmojiHappyFizzBuzzSummarizer_window-2\.txt$/);
  // Each window names what decided it.
  expect(
    facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === "CompactionWindow" ? [fact.observation.decidedBy] : [])) as unknown,
  ).toEqual([policy.name, policy.name]);
  const sent = facts.flatMap((fact) =>
    fact._tag === "Observed" && fact.observation._tag === "ModelRequestDispatched"
      ? [{ provider: fact.observation.provider, messages: sentIn(fact.observation.sent).messages }]
      : [],
  );
  const firstTo = (name: string, input: string) =>
    sent.find((request) => {
      const last = request.messages.at(-1)?.parts.at(-1);
      return request.provider === name && last?._tag === "Text" && last.text === input;
    })?.messages;
  // OpenAI has no summaries: it is sent the whole conversation, from the first input.
  expect(firstTo("openai", "9")?.[0] as unknown).toEqual({ role: "user", parts: [{ _tag: "Text", text: "1" }] });
  // Back on Anthropic: its own summary, the turn that summary's window kept, then everything after
  // the window, OpenAI's turns included.
  const back = firstTo("anthropic", "17");
  expect(back?.slice(0, 2) as unknown).toEqual([
    { role: "instruction", parts: [{ _tag: "Text", text: plain }] },
    { role: "user", parts: [{ _tag: "Text", text: "7" }] },
  ]);
  expect(JSON.stringify(back)).toContain('"text":"9"');
  expect(JSON.stringify(back)).not.toContain("Journey");
  const replies = facts.flatMap((fact) =>
    fact._tag === "Observed" && fact.observation._tag === "ModelResponded"
      ? fact.observation.parts.flatMap((part) => (part._tag === "Text" ? [part.text] : []))
      : [],
  );
  expect(replies as unknown).toEqual(countingUser(10).map((n) => String(Number(n) + 1)));
});

test("A5: a compaction keeps the span's last turn as it was, after the summary; the next compaction summarises it", async () => {
  const { facts, summaries } = await played();
  const windows = facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === "CompactionWindow" ? [fact.observation] : []));
  // Each window keeps one turn: the one that reached the count.
  const delivered = (seqs: ReadonlyArray<number>) =>
    facts.flatMap((fact) => (seqs.includes(fact.seq) && fact._tag === "Decided" && fact.decision._tag === "InputDelivered" ? [fact.seq] : []));
  expect(windows.map((window) => delivered(window.kept).length)).toEqual([1, 1, 1]);
  // The second summary covers the turn the first window kept (29) through 57: 15 turns, 30 messages.
  expect(asText(summaries[1]?.summary ?? receivedJson(null))).toContain("exchanged **30** messages");
});
