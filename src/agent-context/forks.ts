/**
 * A compaction window's summary: what the model is given in place of the span it covers, in one
 * session; the provider whose requests carry it (`kind`); which summarizer wrote it, and when. It is
 * held apart from the session's facts, which record only the window (`CompactionWindow`), so a
 * window can have a summary for each provider, or none for some; none is changed once written. The
 * time it was written says how long it has been since the provider last had a compaction, and so
 * whether its cache can still hold the requests since.
 *
 * Forks as sessions of their own, pointing at the session and position they fork from, are not built
 * yet; this is the part of one a window's summary needs.
 */

import { Schema } from "effect";
import { RecordedAt } from "../agent-machine/fact.ts";
import { ProviderName, SessionId, WindowId } from "../agent-machine/names.ts";
import { Received } from "../agent-machine/received.ts";

/** Which summarizer wrote a summary: a strategy of ours, or the harness a session was imported from. */
export const SummarizerName = Schema.String.pipe(Schema.brand("agent-context/SummarizerName"));
export type SummarizerName = typeof SummarizerName.Type;

export const WindowSummary = Schema.Struct({
  session: SessionId,
  window: WindowId,
  kind: ProviderName,
  writtenBy: SummarizerName,
  writtenAt: RecordedAt,
  summary: Received,
});
export type WindowSummary = typeof WindowSummary.Type;
