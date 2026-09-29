/**
 * A compaction fork's summary: what the model is given in place of one compaction window's span,
 * in one session. It is held apart from the session's facts, which record only the window
 * (`CompactionWindow`), so a window can have more than one summary (from different strategies or
 * providers) and each can be revised or replaced without touching the session.
 *
 * Forks as sessions of their own, pointing at the session and position they fork from, are not built
 * yet; this is the part of one a window's summary needs.
 */

import { Schema } from "effect";
import { SessionId, WindowId } from "../agent-core/names.ts";
import { Received } from "../agent-core/received.ts";

export const WindowSummary = Schema.Struct({ session: SessionId, window: WindowId, summary: Received });
export type WindowSummary = typeof WindowSummary.Type;
