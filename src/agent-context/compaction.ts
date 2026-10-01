/**
 * Compaction, and the conversation it gives each provider.
 *
 * `compact` is run between turns, by the user or by a `CompactionPolicy` (`compactIfDue`). It
 * compacts for the provider the session is asking: the span is every fact after that provider's
 * last summary (from the start of the session when it has none). The span's last turn is kept as it
 * was, to follow the summary, when the span holds a turn before it; a summarizer writes the summary
 * of the rest,
 * the summary is recorded in `Summaries`, and then the window is reported (`CompactionWindow`),
 * naming what decided it was due. The session's facts grow as if nothing were compacted; the
 * window says a summary should exist and nothing about which providers have one.
 *
 * `CompactedConversation` is the view for a session with windows. A request goes to one provider
 * and carries that provider's summaries only. The first request to it after its latest summary
 * carries all of its summaries, in the order written, as one instruction message (consecutive
 * messages of one role are merged); a provider's own compaction was made from the summaries before
 * it, so it is carried in their place. Then come the messages of the facts that summary's window keeps and
 * of those after its span. A later request to it carries on from its last request (A6), and so does
 * a request to a provider whose summaries predate its last request: after a switch back, it goes on
 * from where it was. So two providers in one session can be sent different conversations; what they
 * are both sent is the facts since the later of their summaries. A summary is read from the record
 * and never written again.
 */

import { Context, DateTime, Effect, Layer, Ref } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import type { PolicyName, ProviderName, SessionId, Seq } from "../agent-machine/names.ts";
import { WindowId } from "../agent-machine/names.ts";
import type { Received } from "../agent-machine/received.ts";
import type { ContextMessage, ContextPart, Target, ToolSpec } from "../agent-session/contracts.ts";
import { conversationOf, merged } from "../agent-session/conversation.ts";
import type { Session } from "../agent-session/loop.ts";
import { asText, parseJson, receivedJson } from "../agent-session/received.ts";
import { sentIn } from "../agent-session/sent.ts";
import { modelOf, systemOf, toolsOf } from "../agent-session/session-setup.ts";
import { Conversation } from "./assemble.ts";
import type { SummarizerName, WindowSummary } from "./forks.ts";

/**
 * Writes the summary of a span, given the summaries already written for the same provider and the
 * model the session is asking. A summary is text, or JSON: a provider's own compaction, the items
 * it returned (`provider-compaction.ts`).
 */
/** What every request of the session carries besides the conversation: its system prompt and tools. */
export interface SessionOpening {
  readonly system: string | undefined;
  readonly tools: ReadonlyArray<ToolSpec>;
}

export interface Summarizer {
  readonly name: SummarizerName;
  readonly summarize: (
    previous: ReadonlyArray<WindowSummary>,
    messages: ReadonlyArray<ContextMessage>,
    target: Target,
    opening: SessionOpening,
  ) => Effect.Effect<Received>;
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

/** The summaries of `kind` for the session `facts` open, in the order written. */
const summariesFor = (recorded: ReadonlyArray<WindowSummary>, facts: ReadonlyArray<Fact>, kind: ProviderName) => {
  const session = sessionOf(facts);
  return recorded.filter((each) => each.session === session && each.kind === kind);
};

const windowNamed = (facts: ReadonlyArray<Fact>, window: WindowId): WindowFact["observation"] => {
  const found = windowsOf(facts).find((each) => each.observation.window === window);
  if (found === undefined) throw new Error(`No compaction window ${window} is recorded`);
  return found.observation;
};

/**
 * Compacts `session` for the provider it is asking, with `summarizer`, as `decidedBy` decided: the
 * span is every fact after that provider's last summary's window, the summarizer is given that
 * provider's summaries, the messages of the span, the model the session is asking and the session's
 * system prompt and tools, and the new window is `window-<n>` for the
 * session's n-th window. Run it between turns.
 */
export const compact = (session: Session, summarizer: Summarizer, decidedBy: PolicyName) =>
  Effect.gen(function* () {
    const facts = yield* session.facts;
    const through = facts.at(-1)?.seq;
    if (through === undefined) return yield* Effect.die(new Error("An empty session has nothing to compact"));
    const target = yield* modelOf(facts);
    const kind = target.provider;
    const summaries = yield* Summaries;
    const previous = summariesFor(yield* summaries.recorded, facts, kind);
    const before = previous.at(-1);
    // The span starts after the last summary's span; the turn that window kept was not summarised.
    const window_ = before === undefined ? undefined : windowNamed(facts, before.window);
    const from = window_ === undefined ? undefined : Math.min(window_.through + 1, ...window_.kept);
    const span = from === undefined ? facts : facts.filter((fact) => fact.seq >= from);
    // The last turn is kept as it was, after the summary, when the span holds a turn before it.
    const lastTurn = lastAt(span, (fact) => fact._tag === "Observed" && fact.observation._tag === "TurnStarted");
    const firstTurn = span.findIndex((fact) => fact._tag === "Observed" && fact.observation._tag === "TurnStarted");
    const keeps = lastTurn > firstTurn;
    const summarised = keeps ? span.slice(0, lastTurn) : span;
    const kept = keeps ? span.slice(lastTurn).map((fact) => fact.seq) : [];
    const windows = windowsOf(facts);
    const window = WindowId.make(`window-${windows.length + 1}`);
    const summary = yield* summarizer.summarize(previous, conversationOf(summarised, facts), target, {
      system: systemOf(facts),
      tools: yield* toolsOf(facts),
    });
    yield* summaries.record({
      session: sessionOf(facts),
      window,
      kind,
      writtenBy: summarizer.name,
      writtenAt: yield* DateTime.now,
      summary,
    });
    const last = windows.at(-1);
    yield* session.observe({
      _tag: "CompactionWindow",
      window,
      decidedBy,
      ...(last === undefined ? {} : { previous: last.observation.window }),
      through,
      kept,
    });
    return window;
  });

/**
 * Decides, from the session's facts, whether to compact now and with which summarizer; undefined is
 * not now. Its name is recorded with each window it decides on.
 */
export interface CompactionPolicy {
  readonly name: PolicyName;
  readonly decide: (facts: ReadonlyArray<Fact>) => Summarizer | undefined;
}

/** Compacts `session` if `policy` says to. Run it between turns. */
export const compactIfDue = (session: Session, policy: CompactionPolicy) =>
  Effect.gen(function* () {
    const summarizer = policy.decide(yield* session.facts);
    if (summarizer !== undefined) yield* compact(session, summarizer, policy.name);
  });

/** The parts one summary becomes: its text, or each item of a provider's compaction, for that provider only. */
const summaryParts = (summary: WindowSummary): ReadonlyArray<ContextPart> => {
  if (summary.summary.mediaType !== "application/json") return [{ _tag: "Text", text: asText(summary.summary) }];
  const parsed = parseJson(summary.summary);
  const items = "value" in parsed && Array.isArray(parsed.value) ? parsed.value : [];
  return items.map((item) => ({ _tag: "Unrecognised", provider: summary.kind, received: receivedJson(item) }));
};

/**
 * The summaries a request carries: all of them, in the order written, or those from the latest
 * provider's compaction on, since it was made from the summaries before it.
 */
const carried = (summaries: ReadonlyArray<WindowSummary>): ReadonlyArray<WindowSummary> =>
  summaries.slice(summaries.reduce((from, summary, at) => (summary.summary.mediaType === "application/json" ? at : from), 0));

/**
 * Summaries in an instruction message: the harness speaking, so the input that follows stays a
 * message of its own. A text summary is a `Text` part; a provider's compaction is its items, each an
 * `Unrecognised` part from the provider whose summary it is, which only that provider's adapter
 * sends, unchanged.
 */
export const summaryMessage = (summaries: ReadonlyArray<WindowSummary>): ContextMessage => ({
  role: "instruction",
  parts: carried(summaries).flatMap(summaryParts),
});

/** The position in `facts` of the last fact that `is`, or -1. */
function lastAt(facts: ReadonlyArray<Fact>, is: (fact: Fact) => boolean): number {
  for (let at = facts.length - 1; at >= 0; at--) {
    const fact = facts[at];
    if (fact !== undefined && is(fact)) return at;
  }
  return -1;
}

export const CompactedConversation = Layer.effect(
  Conversation,
  Effect.gen(function* () {
    const summaries = yield* Summaries;
    return {
      messages: (facts) =>
        Effect.gen(function* () {
          const kind = (yield* modelOf(facts)).provider;
          const mine = summariesFor(yield* summaries.recorded, facts, kind);
          const latest = mine.at(-1);
          const lastRequest = lastAt(
            facts,
            (fact) => fact._tag === "Observed" && fact.observation._tag === "ModelRequestDispatched" && fact.observation.provider === kind,
          );
          const window = latest === undefined ? undefined : windowNamed(facts, latest.window);
          const windowAt = window === undefined ? -1 : lastAt(facts, (fact) => fact.seq === window.through);
          const request = facts[lastRequest];
          if (request?._tag === "Observed" && request.observation._tag === "ModelRequestDispatched" && lastRequest > windowAt)
            return merged([...sentIn(request.observation.sent).messages, ...conversationOf(facts.slice(lastRequest + 1), facts)]);
          if (window === undefined) return conversationOf(facts);
          const kept = new Set(window.kept);
          const after = facts.filter((fact) => kept.has(fact.seq) || fact.seq > window.through);
          return merged([summaryMessage(mine), ...conversationOf(after, facts)]);
        }),
    };
  }),
);
