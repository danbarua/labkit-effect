/**
 * Compaction, and the conversation that it gives each provider.
 *
 * `compact` runs between turns, for the provider that the session is asking. It summarises the
 * facts after that provider's latest window, records the summary in `Summaries`, and then records
 * the window (`CompactionWindow`). The session's facts grow as if nothing were compacted. A window
 * does not record which providers have a summary of it.
 *
 * `CompactedConversation` gives a request to a provider only that provider's summaries, followed by
 * the facts after its latest window. A provider that was sent a request since its latest window
 * continues from that request. Two providers in one session can therefore be sent different
 * conversations; both are sent the facts since the later of their summaries.
 */

import { Array as Arr, Context, DateTime, Effect, Layer, Option, Ref } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import type { PolicyName, ProviderName, SessionId, Seq } from "../agent-machine/names.ts";
import { WindowId } from "../agent-machine/names.ts";
import type { Received } from "../agent-machine/received.ts";
import type { ContextMessage, ContextPart, Target, ToolSpec } from "../agent-session/contracts.ts";
import { conversationOf, merged } from "../agent-session/conversation.ts";
import type { Session } from "../agent-session/loop.ts";
import { asText, parseJson, receivedJson } from "../agent-session/received.ts";
import { sentIn } from "../agent-session/sent.ts";
import { modelOf, immutableSystemPromptOf, immutableToolCatalogOf } from "../agent-session/configuration/session-setup.ts";
import { Conversation } from "./assemble.ts";
import type { SummarizerName, WindowSummary } from "./forks.ts";

/** What every request of the session carries besides the conversation: its system prompt and tools. */
export interface SessionOpening {
  readonly system: string | undefined;
  readonly tools: ReadonlyArray<ToolSpec>;
}

/**
 * Writes the summary of a span. `summarize` receives the provider's earlier summaries, the span's
 * messages, the model that the session is asking, and the session's system prompt and tools. A
 * summary is text, or JSON: the items of a provider's own compaction (`provider-compaction.ts`).
 */
export interface Summarizer {
  readonly name: SummarizerName;
  readonly summarize: (
    previous: ReadonlyArray<WindowSummary>,
    messages: ReadonlyArray<ContextMessage>,
    target: Target,
    opening: SessionOpening,
  ) => Effect.Effect<Received>;
}

/** The record of summaries: `record` adds one, and `recorded` returns all of them in the order written. A recorded summary is never changed. */
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

/** Returns the summaries of provider `kind` for the session that `facts` open, in the order written. */
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
 * Compacts `session` for the provider that it is asking, with `summarizer`, and records `decidedBy`
 * as the policy that decided. Run it between turns.
 * 1. The span is every fact after that provider's latest window, from the turn that the window
 *    kept. With no earlier summary for the provider, the span starts at the session's beginning.
 * 2. When the span holds more than one turn, its last turn is kept unsummarised.
 * 3. The summary is recorded, then the window `window-<n>`, for the session's n-th window. A summary
 *    that fails to record therefore leaves no window.
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
    // The turn that the previous window kept was not summarised, so the span starts with it.
    const previousWindow = before === undefined ? undefined : windowNamed(facts, before.window);
    const spanStart = previousWindow === undefined ? undefined : Math.min(previousWindow.through + 1, ...previousWindow.kept);
    const span = spanStart === undefined ? facts : facts.filter((fact) => fact.seq >= spanStart);
    // The span's last turn is kept unsummarised, after the summary, when the span holds an earlier turn.
    const lastTurn = lastIndexWhere(span, (fact) => fact._tag === "Observed" && fact.observation._tag === "TurnStarted");
    const firstTurn = span.findIndex((fact) => fact._tag === "Observed" && fact.observation._tag === "TurnStarted");
    const keepsLastTurn = lastTurn > firstTurn;
    const summarised = keepsLastTurn ? span.slice(0, lastTurn) : span;
    const kept = keepsLastTurn ? span.slice(lastTurn).map((fact) => fact.seq) : [];
    const windows = windowsOf(facts);
    const window = WindowId.make(`window-${windows.length + 1}`);
    const summary = yield* summarizer.summarize(previous, conversationOf(summarised, facts), target, {
      system: immutableSystemPromptOf(facts),
      tools: yield* immutableToolCatalogOf(facts),
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
 * Decides from the session's facts whether to compact now, and with which summarizer. `decide`
 * returns undefined when no compaction is due. The policy's name is recorded on each window that it
 * decides.
 */
export interface CompactionPolicy {
  readonly name: PolicyName;
  readonly decide: (facts: ReadonlyArray<Fact>) => Summarizer | undefined;
}

/** Compacts `session` when `policy` says that a compaction is due. Run it between turns. */
export const compactIfDue = (session: Session, policy: CompactionPolicy) =>
  Effect.gen(function* () {
    const summarizer = policy.decide(yield* session.facts);
    if (summarizer !== undefined) yield* compact(session, summarizer, policy.name);
  });

/** Returns one summary's message parts: a `Text` part, or one `Unrecognised` part per item of a provider's compaction, which only that provider's adapter sends. */
const summaryParts = (summary: WindowSummary): ReadonlyArray<ContextPart> => {
  if (summary.summary.mediaType !== "application/json") return [{ _tag: "Text", text: asText(summary.summary) }];
  const parsed = parseJson(summary.summary);
  const items = "value" in parsed && Array.isArray(parsed.value) ? parsed.value : [];
  return items.map((item) => ({ _tag: "Unrecognised", provider: summary.kind, from: { _tag: "Compaction", window: summary.window }, received: receivedJson(item) }));
};

/**
 * Returns the summaries that a request carries, in the order written, starting from the latest
 * provider compaction, which was made from the summaries before it.
 */
const summariesCarried = (summaries: ReadonlyArray<WindowSummary>): ReadonlyArray<WindowSummary> =>
  summaries.slice(summaries.reduce((start, summary, at) => (summary.summary.mediaType === "application/json" ? at : start), 0));

/**
 * Returns the summaries as one instruction message. The instruction role marks the harness as the
 * speaker, so the input that follows stays a separate message.
 */
export const summaryMessage = (summaries: ReadonlyArray<WindowSummary>): ContextMessage => ({
  role: "instruction",
  parts: summariesCarried(summaries).flatMap(summaryParts),
});

/** Returns the index of the last fact in `facts` for which `is` returns true, or -1. */
function lastIndexWhere(facts: ReadonlyArray<Fact>, is: (fact: Fact) => boolean): number {
  return Option.getOrElse(Arr.findLastIndex(facts, is), () => -1);
}

/** The `Conversation` for a session with compaction windows, as the module comment describes. */
export const CompactedConversation = Layer.effect(
  Conversation,
  Effect.gen(function* () {
    const summaries = yield* Summaries;
    return {
      messages: (facts) =>
        Effect.gen(function* () {
          const kind = (yield* modelOf(facts)).provider;
          const providerSummaries = summariesFor(yield* summaries.recorded, facts, kind);
          const latest = providerSummaries.at(-1);
          const lastRequest = lastIndexWhere(
            facts,
            (fact) => fact._tag === "Observed" && fact.observation._tag === "ModelRequestDispatched" && fact.observation.provider === kind,
          );
          const window = latest === undefined ? undefined : windowNamed(facts, latest.window);
          const windowAt = window === undefined ? -1 : lastIndexWhere(facts, (fact) => fact.seq === window.through);
          const request = facts[lastRequest];
          if (request?._tag === "Observed" && request.observation._tag === "ModelRequestDispatched" && lastRequest > windowAt)
            return merged([...sentIn(request.observation.sent).messages, ...conversationOf(facts.slice(lastRequest + 1), facts)]);
          if (window === undefined) return conversationOf(facts);
          const kept = new Set(window.kept);
          const after = facts.filter((fact) => kept.has(fact.seq) || fact.seq > window.through);
          return merged([summaryMessage(providerSummaries), ...conversationOf(after, facts)]);
        }),
    };
  }),
);
