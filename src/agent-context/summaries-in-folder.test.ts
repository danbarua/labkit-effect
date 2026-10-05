/** `SummariesInFolder`: summaries kept as files, read back in the order they were written. */

import { expect } from "bun:test";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { DateTime, Effect, Layer } from "effect";
import { ProviderName, SessionId, WindowId } from "../agent-machine/names.ts";
import { asText, receivedJson, receivedText } from "../agent-session/received.ts";
import { test, testFolder } from "../../tests/support/test.ts";
import { Summaries } from "./compaction.ts";
import { SummarizerName, type WindowSummary } from "./forks.ts";
import { SummariesInFolder } from "./summaries-in-folder.ts";

const summaryOf = (text: string, writtenAt: string): WindowSummary => ({
  session: SessionId.make("s1"),
  window: WindowId.make("window-1"),
  kind: ProviderName.make("anthropic"),
  writtenBy: SummarizerName.make("PlainTextFizzBuzzSummarizer"),
  writtenAt: DateTime.makeUnsafe(writtenAt),
  summary: receivedText(text),
});

test("summaries of one kind written in the same millisecond are read in the order they were recorded", async () => {
  const texts = await Effect.gen(function* () {
    const summaries = yield* Summaries;
    yield* summaries.record(summaryOf("first", "2026-10-05T10:00:00.000Z"));
    yield* summaries.record(summaryOf("second", "2026-10-05T10:00:00.000Z"));
    return (yield* summaries.recorded).map((each) => asText(each.summary));
  }).pipe(
    Effect.provide(SummariesInFolder(join(testFolder(), "summaries")).pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)))),
    Effect.runPromise,
  );
  expect(texts).toEqual(["first", "second"]);
});

test("a JSON summary, a provider's own compaction, is read back from its folder as JSON", async () => {
  const read = await Effect.gen(function* () {
    const summaries = yield* Summaries;
    yield* summaries.record({ ...summaryOf("", "2026-10-05T10:00:00.000Z"), summary: receivedJson([{ type: "compaction", encrypted_content: "abc" }]) });
    return (yield* summaries.recorded).map((each) => ({ mediaType: each.summary.mediaType, text: asText(each.summary) }));
  }).pipe(
    Effect.provide(SummariesInFolder(join(testFolder(), "summaries")).pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)))),
    Effect.runPromise,
  );
  expect(read as unknown).toEqual([{ mediaType: "application/json", text: '[{"type":"compaction","encrypted_content":"abc"}]' }]);
});
