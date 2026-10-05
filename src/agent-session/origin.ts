/**
 * The origin of the observations that a program gives a session. A caller of `session.observe`
 * sets it around the call with `reportedBy`, and the loop records each observation with it. An
 * observation given with no origin set is a defect.
 *
 * The loop records what it observes itself (a request's outcome, a turn starting) with the origin
 * that it knows: the provider, the tool, or the part of the harness.
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

/**
 * The origin of a policy's veto, question or held request: the policy, by its name in its list.
 * `seam` is "tool call policy" (whether a tool call runs) or "model request policy" (whether a
 * model request is made).
 */
export const policyPart = (seam: string, name: string): Extract<Origin, { _tag: "Harness" }> => harness(`${seam} ${name}`);

/** The parts of the harness that report observations. */
export const harnessParts = {
  /** Starts turns. */
  loop: harness("loop"),
  /** Runs the hooks that may hold a turn open before it ends. */
  turnEndHooks: harness("turn-end hooks"),
  /** Sends a request to the next provider when one cannot serve it. */
  fallbackChain: harness("fallback chain"),
  /** Builds what the model is sent. */
  contextAssembler: harness("context assembler"),
  /** Continues a session from its facts, and records what is known of the requests they leave under way. */
  resume: harness("resume"),
  /** Hands each tool call to the tool that runs it. */
  toolRunner: harness("tool runner"),
  /** Keeps the session's MCP servers, and records when one is ready, failed, exited or stopped. */
  mcpServers: harness("mcp servers"),
  /** Puts a session's settings into a request that the model accepts. */
  modelSettings: harness("model settings"),
} as const;
