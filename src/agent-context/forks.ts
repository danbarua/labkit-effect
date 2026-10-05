/**
 * A compaction window's summary (`WindowSummary`): what one provider is sent in place of the span
 * that the window covers. Summaries are kept apart from the session's facts, which record only the
 * window (`CompactionWindow`), so a window can have a summary for each provider, or none for some.
 * A summary is never changed once written. `writtenAt` shows how long it has been since the
 * provider's last compaction, and so whether the provider's cache can still hold the requests
 * since.
 *
 * Forks as sessions of their own are not built. This file holds the part of a fork that a window's
 * summary needs.
 */

import { Schema } from "effect";
import { RecordedAt } from "../agent-machine/fact.ts";
import { ProviderName, SessionId, WindowId } from "../agent-machine/names.ts";
import { Received } from "../agent-machine/received.ts";

/** The name of the summarizer that wrote a summary: one of this project's summarizers, or the harness that a session was imported from. */
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
