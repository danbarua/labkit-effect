/**
 * Who is reporting the observations a program gives a session. Whoever calls `session.observe` sets
 * it around the call with `reportedBy`; the loop records each observation with it. An observation
 * given with none set has no origin to be recorded with, which is a defect.
 *
 * What the loop observes itself (a request's outcome, a turn starting) it records with the origin
 * it knows: the provider, the tool, or the part of the harness.
 */

import { Context, Effect } from "effect";
import { HarnessPart } from "../agent-machine/names.ts";
import type { Origin } from "../agent-machine/origin.ts";

export const CurrentOrigin = Context.Reference<Origin | undefined>("agent-session/CurrentOrigin", {
  defaultValue: () => undefined,
});

/** Runs `effect` with `origin` as the origin of the observations it gives a session. */
export const reportedBy =
  (origin: Origin) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, CurrentOrigin, origin);

const harness = (part: string): Extract<Origin, { _tag: "Harness" }> => ({ _tag: "Harness", part: HarnessPart.make(part) });

/** The parts of the harness that report observations. */
export const harnessParts = {
  /** Starts turns. */
  loop: harness("loop"),
  /** Runs what may hold a turn open before it ends. */
  turnEndHooks: harness("turn-end hooks"),
  /** Sends a request to the next provider when one cannot serve it. */
  fallbackChain: harness("fallback chain"),
  /** Builds what the model is sent. */
  contextAssembler: harness("context assembler"),
  /** Goes on from a session's facts, and says what is known of the requests they leave under way. */
  resume: harness("resume"),
  /** Hands each tool call to the tool that runs it. */
  toolRunner: harness("tool runner"),
  /** Decides whether a tool call runs: lets it, vetoes it, or asks first. */
  toolCallPolicy: harness("tool call policy"),
  /** Puts a session's settings into a request a model accepts. */
  modelSettings: harness("model settings"),
} as const;
