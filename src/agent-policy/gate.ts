/**
 * The gate sits between the core's effect requests and the adapters that carry them out, and
 * applies a policy to each request. A request the policy lets continue is forwarded to the
 * adapters; a vetoed one becomes the observation the core records for a veto; a request the policy
 * holds waits, with what the policy asked for passed on to be answered.
 *
 * `StartTurn` is forwarded without review: the core has no outcome for a turn that is not started.
 */

import { Schema } from "effect";
import type { Observation } from "../agent-core/observation.ts";
import type { EffectRequest } from "../agent-core/request.ts";
import type { Json, Policy, PolicyMessage, PolicyStep } from "./policy.ts";

/** Identifies a request under review: one model request per turn, one run per tool call. */
export const RequestKey = Schema.String.pipe(Schema.brand("RequestKey"));
export type RequestKey = typeof RequestKey.Type;

type Reviewed = Exclude<EffectRequest, { _tag: "StartTurn" }>;

export function keyOf(request: Reviewed): RequestKey {
  switch (request._tag) {
    case "RequestModelResponse":
      return RequestKey.make(`model:${request.turn}`);
    case "RunTool":
      return RequestKey.make(`tool:${request.call}`);
    default:
      return request satisfies never;
  }
}

function vetoed(request: Reviewed, reason: Json): Observation {
  switch (request._tag) {
    case "RequestModelResponse":
      return { _tag: "ModelVetoed", turn: request.turn, reason };
    case "RunTool":
      return { _tag: "ToolEnded", call: request.call, outcome: { _tag: "Vetoed", reason } };
    default:
      return request satisfies never;
  }
}

export type GateInput =
  /** The core sent an effect request. */
  | { readonly _tag: "Requested"; readonly request: EffectRequest }
  /** An answer for the request under review at `key`. */
  | { readonly _tag: "Answered"; readonly key: RequestKey; readonly answer: Json }
  /** The clock reached `at`; every waiting policy is told. */
  | { readonly _tag: "Tick"; readonly message: Extract<PolicyMessage, { _tag: "Tick" }> };

export type GateOutput =
  /** Carry out this request. */
  | { readonly _tag: "Forward"; readonly request: EffectRequest }
  /** Give this observation to the core. */
  | { readonly _tag: "Observe"; readonly observation: Observation }
  /** The policy reviewing `key` asks for this to be answered. */
  | { readonly _tag: "Ask"; readonly key: RequestKey; readonly asks: Json };

export interface GateState<State> {
  readonly waiting: ReadonlyMap<RequestKey, { readonly request: Reviewed; readonly state: State }>;
}

export interface GateStep<State> {
  readonly gate: GateState<State>;
  readonly outputs: ReadonlyArray<GateOutput>;
}

export function emptyGate<State>(): GateState<State> {
  return { waiting: new Map() };
}

export function gate<State>(
  policy: Policy<State>,
  held: GateState<State>,
  input: GateInput,
): GateStep<State> {
  const waiting = new Map(held.waiting);
  const outputs: Array<GateOutput> = [];
  const settle = (key: RequestKey, request: Reviewed, step: PolicyStep<State>): void => {
    switch (step._tag) {
      case "Waiting":
        waiting.set(key, { request, state: step.state });
        if (step.asks !== undefined) outputs.push({ _tag: "Ask", key, asks: step.asks });
        return;
      case "Decided":
        waiting.delete(key);
        switch (step.verdict._tag) {
          case "Continue":
            outputs.push({ _tag: "Forward", request });
            return;
          case "Veto":
            outputs.push({ _tag: "Observe", observation: vetoed(request, step.verdict.reason) });
            return;
          default:
            return step.verdict satisfies never;
        }
      default:
        return step satisfies never;
    }
  };

  switch (input._tag) {
    case "Requested": {
      const request = input.request;
      if (request._tag === "StartTurn") outputs.push({ _tag: "Forward", request });
      else settle(keyOf(request), request, policy.start(request));
      break;
    }
    case "Answered": {
      const held = waiting.get(input.key);
      if (held !== undefined)
        settle(input.key, held.request, policy.receive(held.state, { _tag: "Answered", answer: input.answer }));
      break;
    }
    case "Tick":
      for (const [key, held] of [...waiting]) settle(key, held.request, policy.receive(held.state, input.message));
      break;
    default:
      input satisfies never;
  }
  return { gate: { waiting }, outputs };
}
