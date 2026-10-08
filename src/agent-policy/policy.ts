/**
 * A policy decides whether one effect request continues, is vetoed, or waits. A policy is a state
 * machine for one request: `start` returns a verdict or waits, and `receive` handles a message
 * while the policy waits. Waiting is how a policy delays an effect.
 */

import { Schema } from "effect";
import { FailureText, Millis } from "../agent-machine/names.ts";
import { Received } from "../agent-machine/received.ts";
import type { EffectRequest } from "../agent-machine/request.ts";

export const Verdict = Schema.Union([
  Schema.TaggedStruct("Continue", {}),
  /** The effect is not carried out. The loop passes `reason` to the core unchanged. */
  Schema.TaggedStruct("Veto", { reason: Received }),
]);
export type Verdict = typeof Verdict.Type;

/** A message that the loop sends to a waiting policy. */
export const PolicyMessage = Schema.Union([
  /** The answer to the policy's question, as the person or client gave it. */
  Schema.TaggedStruct("Answered", { answer: Received }),
  /** The policy's question has no answer, because asking it failed as `problem` says. */
  Schema.TaggedStruct("AskingFailed", { problem: FailureText }),
  /** The clock reached `at`. */
  Schema.TaggedStruct("Tick", { at: Millis }),
]);
export type PolicyMessage = typeof PolicyMessage.Type;

export type PolicyStep<State> =
  /** A verdict. On a veto from `every`, `by` is the position of the policy that vetoed. */
  | { readonly _tag: "Decided"; readonly verdict: Verdict; readonly by?: number }
  /**
   * No verdict yet. `asks` is the question that the policy wants answered, if any. The layer that
   * shows the question to a person interprets it.
   */
  | {
      readonly _tag: "Waiting";
      readonly state: State;
      readonly asks: Received | undefined;
    };

export interface Policy<State> {
  readonly start: (request: EffectRequest) => PolicyStep<State>;
  readonly receive: (state: State, message: PolicyMessage) => PolicyStep<State>;
}

/** The state of `every` while a policy waits: the request, the waiting policy's position, and its state. */
export interface EveryState {
  readonly request: EffectRequest;
  readonly index: number;
  readonly state: unknown;
}

/**
 * Returns a policy that applies `policies` in order.
 * - The first veto is the verdict, with `by` set to the vetoing policy's position.
 * - A policy that waits holds the policies after it until it decides.
 * - The request continues when every policy lets it continue.
 */
export function every(policies: ReadonlyArray<Policy<unknown>>): Policy<EveryState> {
  const decided: PolicyStep<EveryState> = { _tag: "Decided", verdict: { _tag: "Continue" } };
  /** Returns the combined step after the policy at `index` returned `step`. */
  const combined = (request: EffectRequest, index: number, step: PolicyStep<unknown>): PolicyStep<EveryState> => {
    switch (step._tag) {
      case "Waiting":
        return { _tag: "Waiting", state: { request, index, state: step.state }, asks: step.asks };
      case "Decided":
        switch (step.verdict._tag) {
          case "Veto":
            return { ...step, by: index };
          case "Continue": {
            const next = policies[index + 1];
            return next === undefined ? step : combined(request, index + 1, next.start(request));
          }
          default:
            return step.verdict satisfies never;
        }
      default:
        return step satisfies never;
    }
  };
  return {
    start: (request) => {
      const first = policies[0];
      return first === undefined ? decided : combined(request, 0, first.start(request));
    },
    receive: (held, message) => {
      const policy = policies[held.index];
      return policy === undefined
        ? decided
        : combined(held.request, held.index, policy.receive(held.state, message));
    },
  };
}
