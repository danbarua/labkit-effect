/**
 * Who is reporting the observations a program gives a session. Whoever calls `session.observe` sets
 * it around the call with `reportedBy`; the loop records each observation with it. An observation
 * given with none set has no origin to be recorded with, which is a defect.
 *
 * What the loop observes itself (a request's outcome, a turn starting) it records with the origin
 * it knows: the provider, the tool, or the part of the harness.
 */

import { Context, Effect } from "effect";
import { HarnessPart } from "../agent-core/names.ts";
import type { Origin } from "../agent-core/origin.ts";

export const CurrentOrigin = Context.Reference<Origin | undefined>("agent-effect/CurrentOrigin", {
  defaultValue: () => undefined,
});

/** Runs `effect` with `origin` as the origin of the observations it gives a session. */
export const reportedBy =
  (origin: Origin) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, CurrentOrigin, origin);

const harness = (part: string): Origin => ({ _tag: "Harness", part: HarnessPart.make(part) });

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
  /** Puts a session's settings into a request a model accepts. */
  modelSettings: harness("model settings"),
} as const;
