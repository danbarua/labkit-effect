/** `compact` and `CompactedConversation`, over facts built by hand. */

import { expect } from "bun:test";
import { DateTime, Effect, Layer, Schema } from "effect";
import { observe, open, opened } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";
import { test } from "../../tests/support/test.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { PolicyName, ProviderName, SessionId, WindowId } from "../agent-machine/names.ts";
import { type ContextMessage, ModelContext } from "../agent-session/contracts.ts";
import type { Session } from "../agent-session/loop.ts";
import type { SessionStoreFailed } from "../agent-session/session-store.ts";
import { receivedText } from "../agent-session/received.ts";
import { CompactedConversation, compact, type Summarizer, Summaries, SummariesInMemory } from "./compaction.ts";
import { Conversation } from "./assemble.ts";
import { SummarizerName, type WindowSummary } from "./forks.ts";

const sent = (messages: ReadonlyArray<ContextMessage>) =>
  json(Schema.encodeSync(Schema.toCodecJson(ModelContext))({ system: undefined, tools: [], messages }));

const user = (text: string): ContextMessage => ({ role: "user", parts: [{ _tag: "Text", text }] });

/** A session driven by hand: `compact` reads its facts and records what it observes in them. */
const drivenSession = () => {
  const driven = open();
  const session = {
    facts: Effect.sync(() => [...driven.journal]),
    observe: (observation: unknown) => Effect.sync(() => void observe(driven, observation)),
  } as unknown as Session;
  return { driven, session };
};

/** `compact` over a driven session, which needs none of the loop's services that `Session`'s type asks for. */
const compacting = (session: Session) => compact(session, summarizer, decidedBy) as unknown as Effect.Effect<WindowId, SessionStoreFailed, Summaries>;

const summarizer: Summarizer = { name: SummarizerName.make("Fixed"), summarize: () => Effect.succeed(receivedText("A summary.")) };
const decidedBy = PolicyName.make("by hand");

const windowsIn = (facts: ReadonlyArray<Fact>) =>
  facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === "CompactionWindow" ? [fact.observation] : []));

test("compact records the summary before the window: when recording the summary fails, no window is recorded", async () => {
  const { driven, session } = drivenSession();
  observe(driven, opened);
  observe(driven, { _tag: "InputArrived", from: { _tag: "User" }, text: "count" });
  const failing = Layer.succeed(Summaries, { record: () => Effect.die(new Error("the disk is full")), recorded: Effect.succeed([]) });
  const exit = await Effect.runPromiseExit(compacting(session).pipe(Effect.provide(failing)));
  expect(exit._tag).toBe("Failure");
  expect(windowsIn(driven.journal)).toEqual([]);
});

test("each compaction window after the first records the window before it as previous", async () => {
  const { driven, session } = drivenSession();
  observe(driven, opened);
  observe(driven, { _tag: "InputArrived", from: { _tag: "User" }, text: "count" });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* compacting(session);
      yield* compacting(session);
    }).pipe(Effect.provide(SummariesInMemory)),
  );
  expect(windowsIn(driven.journal).map((window) => ({ window: window.window, previous: window.previous })) as unknown).toEqual([
    { window: "window-1", previous: undefined },
    { window: "window-2", previous: "window-1" },
  ]);
});

/** The messages `CompactedConversation` gives for `facts`, with `recorded` already in the summaries. */
const compactedMessages = (facts: ReadonlyArray<Fact>, recorded: ReadonlyArray<WindowSummary>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const summaries = yield* Summaries;
      yield* Effect.forEach(recorded, (summary) => summaries.record(summary), { discard: true });
      return yield* (yield* Conversation).messages(facts);
    }).pipe(Effect.provide(CompactedConversation.pipe(Layer.provideMerge(SummariesInMemory)))),
  );

const summaryOf = (session: string): WindowSummary => ({
  session: SessionId.make(session),
  window: WindowId.make("window-1"),
  kind: ProviderName.make("boring"),
  writtenBy: SummarizerName.make("Fixed"),
  writtenAt: DateTime.makeUnsafe("2026-10-05T10:00:00.000Z"),
  summary: receivedText(`The summary of ${session}.`),
});

test("a request to a provider that was sent a request after its latest window carries on from that request's messages as recorded", async () => {
  const driven = open();
  observe(driven, opened);
  observe(driven, { _tag: "InputArrived", from: { _tag: "User" }, text: "count" });
  observe(driven, { _tag: "CompactionWindow", window: "window-1", decidedBy: "by hand", through: 2, kept: [] });
  const recorded = [user("as the request after the window carried it")];
  observe(driven, { _tag: "ModelRequestDispatched", turn: "turn-1", provider: "boring", model: "boring-1", sent: sent(recorded) });
  expect(await compactedMessages(driven.journal, [summaryOf("s1")])).toEqual(recorded);
});

test("a session's requests carry no summary of another session, though both sessions ask the same provider", async () => {
  const driven = open();
  observe(driven, opened);
  observe(driven, { _tag: "InputArrived", from: { _tag: "User" }, text: "count" });
  expect(await compactedMessages(driven.journal, [summaryOf("another session")])).toEqual([user("count")]);
});
