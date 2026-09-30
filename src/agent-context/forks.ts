/**
 * A compaction window's summary: what the model is given in place of one compaction window's span,
 * in one session, and which summarizer wrote it. It is held apart from the session's facts, which
 * record only the window (`CompactionWindow`), so a window can have more than one summary (from
 * different strategies or providers); another is added beside the first, and none is changed once
 * written.
 *
 * Forks as sessions of their own, pointing at the session and position they fork from, are not built
 * yet; this is the part of one a window's summary needs.
 */

import { Schema } from "effect";
import { SessionId, WindowId } from "../agent-machine/names.ts";
import { Received } from "../agent-machine/received.ts";

/** Which summarizer wrote a summary: a strategy of ours, or the harness a session was imported from. */
export const SummarizerName = Schema.String.pipe(Schema.brand("agent-context/SummarizerName"));
export type SummarizerName = typeof SummarizerName.Type;

export const WindowSummary = Schema.Struct({
  session: SessionId,
  window: WindowId,
  writtenBy: SummarizerName,
  summary: Received,
});
export type WindowSummary = typeof WindowSummary.Type;
