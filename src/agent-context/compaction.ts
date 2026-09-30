/**
 * Compaction on request, and the conversation it gives.
 *
 * `compact` is run between turns by whoever asks for it (the user, a scenario). It chooses the span
 * since the last window, has a summarizer write a summary of it, records the summary in
 * `Summaries`, and then reports the window (`CompactionWindow`), so the summary is on record before
 * any request is made in the window.
 *
 * `CompactedConversation` is the view for a session with windows. The session's facts grow as if
 * nothing were compacted; the summaries are a second record beside them. The first request in a
 * window carries the summary of every window opened so far, in order, as each was recorded, then
 * the messages of the facts the window keeps and of those after its span. Every later request
 * carries on from the one before it (`nextMessages`). A summary is read from the record and never
 * written again, so changing the summarizer changes the summaries of later windows and nothing
 * already written.
 */

import { Context, Effect, Layer, Ref } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import { type SessionId, type Seq, WindowId } from "../agent-machine/names.ts";
import type { ContextMessage } from "../agent-session/contracts.ts";
import { conversationOf, merged, nextMessages } from "../agent-session/conversation.ts";
import type { Session } from "../agent-session/loop.ts";
import { asText, receivedText } from "../agent-session/received.ts";
import { Conversation } from "./assemble.ts";
import type { SummarizerName, WindowSummary } from "./forks.ts";

/** Writes the summary of a window's span, given the summaries already written for the windows before it. */
export interface Summarizer {
  readonly name: SummarizerName;
  readonly summarize: (
    previous: ReadonlyArray<WindowSummary>,
    messages: ReadonlyArray<ContextMessage>,
  ) => Effect.Effect<string>;
}

/** The summaries written so far, in the order written. A summary once recorded is not changed. */
export class Summaries extends Context.Service<
  Summaries,
  {
    readonly record: (summary: WindowSummary) => Effect.Effect<void>;
    readonly recorded: Effect.Effect<ReadonlyArray<WindowSummary>>;
  }
>()("agent-context/Summaries") {}

/** Summaries held in memory, for as long as the layer lasts. */
export const SummariesInMemory = Layer.effect(
  Summaries,
  Effect.gen(function* () {
    const all = yield* Ref.make<ReadonlyArray<WindowSummary>>([]);
    return {
      record: (summary) => Ref.update(all, (before) => [...before, summary]),
      recorded: Ref.get(all),
    };
  }),
);

type WindowFact = Extract<Fact, { _tag: "Observed" }> & {
  readonly observation: { readonly _tag: "CompactionWindow"; readonly window: WindowId; readonly through: Seq; readonly kept: ReadonlyArray<Seq> };
};

const windowsOf = (facts: ReadonlyArray<Fact>): ReadonlyArray<WindowFact> =>
  facts.filter((fact): fact is WindowFact => fact._tag === "Observed" && fact.observation._tag === "CompactionWindow");

const sessionOf = (facts: ReadonlyArray<Fact>): SessionId => {
  const opened = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "SessionOpened");
  if (opened?._tag !== "Observed" || opened.observation._tag !== "SessionOpened") throw new Error("The session's facts do not open it");
  return opened.observation.session;
};

/**
 * Compacts `session` with `summarizer`: the span is every fact after the last window's span, the
 * summarizer is given the summaries of the windows before and the messages of the span, and the new
 * window is `window-<n>` for the session's n-th window. Run it between turns.
 */
export const compact = (session: Session, summarizer: Summarizer) =>
  Effect.gen(function* () {
    const facts = yield* session.facts;
    const windows = windowsOf(facts);
    const last = windows.at(-1);
    const through = facts.at(-1)?.seq;
    if (through === undefined) return yield* Effect.die(new Error("An empty session has nothing to compact"));
    const span = last === undefined ? facts : facts.filter((fact) => fact.seq > last.observation.through);
    const summaries = yield* Summaries;
    const id = sessionOf(facts);
    const previous = (yield* summaries.recorded).filter((each) => each.session === id);
    const window = WindowId.make(`window-${windows.length + 1}`);
    const text = yield* summarizer.summarize(previous, conversationOf(span, facts));
    yield* summaries.record({ session: id, window, writtenBy: summarizer.name, summary: receivedText(text) });
    yield* session.observe({
      _tag: "CompactionWindow",
      window,
      ...(last === undefined ? {} : { previous: last.observation.window }),
      through,
      kept: [],
    });
    return window;
  });

/** Every window's summary, as a message: the text the summarizer wrote. */
const summaryMessage = (summary: WindowSummary): ContextMessage => ({
  role: "user",
  parts: [{ _tag: "Text", text: asText(summary.summary) }],
});

export const CompactedConversation = Layer.effect(
  Conversation,
  Effect.gen(function* () {
    const summaries = yield* Summaries;
    return {
      messages: (facts) =>
        Effect.gen(function* () {
          const opened = facts.flatMap((fact, at) =>
            fact._tag === "Decided" && fact.decision._tag === "WindowOpened" ? [{ at, compaction: fact.decision.compaction }] : [],
          );
          const latest = opened.at(-1);
          const dispatchedSince = facts.some(
            (fact, at) => latest !== undefined && at > latest.at && fact._tag === "Observed" && fact.observation._tag === "ModelRequestDispatched",
          );
          if (latest === undefined || dispatchedSince) return nextMessages(facts);
          const windows = windowsOf(facts);
          const windowAt = (seq: Seq): WindowFact["observation"] => {
            const found = windows.find((each) => each.seq === seq);
            if (found === undefined) throw new Error(`No compaction window is recorded at ${seq}`);
            return found.observation;
          };
          const id = sessionOf(facts);
          const recorded = yield* summaries.recorded;
          const carried = opened.map(({ compaction }) => {
            const window = windowAt(compaction).window;
            const summary = recorded.find((each) => each.session === id && each.window === window);
            if (summary === undefined) throw new Error(`No summary is recorded for ${window}`);
            return summaryMessage(summary);
          });
          const current = windowAt(latest.compaction);
          const kept = new Set(current.kept);
          const after = facts.filter((fact) => kept.has(fact.seq) || fact.seq > current.through);
          return merged([...carried, ...conversationOf(after, facts)]);
        }),
    };
  }),
);
