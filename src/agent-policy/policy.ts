/**
 * A policy decides whether one effect request continues or is vetoed. It is a machine: given the
 * request it gives a verdict, or waits; given a message while waiting it gives a verdict, or waits
 * again. Waiting is how a policy delays an effect. How it reaches a verdict (rules, parsing a
 * command, a model's judgement, asking a person) is the policy's own business.
 */

import { Schema } from "effect";
import { Millis } from "../agent-core/names.ts";
import { Received } from "../agent-core/received.ts";
import type { EffectRequest } from "../agent-core/request.ts";

export const Verdict = Schema.Union([
  Schema.TaggedStruct("Continue", {}),
  /** The effect does not happen. `reason` is passed to the core as the policy gave it. */
  Schema.TaggedStruct("Veto", { reason: Received }),
]);
export type Verdict = typeof Verdict.Type;

/** What a waiting policy can be sent. */
export const PolicyMessage = Schema.Union([
  /** An answer to what the policy asked for while waiting, as the answerer gave it. */
  Schema.TaggedStruct("Answered", { answer: Received }),
  /** The clock reached `at`. */
  Schema.TaggedStruct("Tick", { at: Millis }),
]);
export type PolicyMessage = typeof PolicyMessage.Type;

export type PolicyStep<State> =
  | { readonly _tag: "Decided"; readonly verdict: Verdict }
  /**
   * No verdict yet. `asks` is what the policy wants answered, if anything, as it states it; the
   * layer that shows it to someone interprets it.
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

/** The state of `every`: which policy is waiting, and its state. */
export interface EveryState {
  readonly request: EffectRequest;
  readonly index: number;
  readonly state: unknown;
}

/**
 * Policies applied in order: the first veto is the verdict; the request continues when every
 * policy lets it continue. A waiting policy holds the ones after it.
 */
export function every(policies: ReadonlyArray<Policy<unknown>>): Policy<EveryState> {
  const decided: PolicyStep<EveryState> = { _tag: "Decided", verdict: { _tag: "Continue" } };
  /** The combined step after the policy at `index` took `step`. */
  const from = (request: EffectRequest, index: number, step: PolicyStep<unknown>): PolicyStep<EveryState> => {
    switch (step._tag) {
      case "Waiting":
        return { _tag: "Waiting", state: { request, index, state: step.state }, asks: step.asks };
      case "Decided":
        switch (step.verdict._tag) {
          case "Veto":
            return step;
          case "Continue": {
            const next = policies[index + 1];
            return next === undefined ? step : from(request, index + 1, next.start(request));
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
      return first === undefined ? decided : from(request, 0, first.start(request));
    },
    receive: (held, message) => {
      const policy = policies[held.index];
      return policy === undefined
        ? decided
        : from(held.request, held.index, policy.receive(held.state, message));
    },
  };
}
