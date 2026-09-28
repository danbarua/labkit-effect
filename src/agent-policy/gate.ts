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
import type { Received } from "../agent-core/received.ts";
import type { Policy, PolicyMessage, PolicyStep } from "./policy.ts";

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

function vetoed(request: Reviewed, reason: Received): Observation {
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
  | { readonly _tag: "Answered"; readonly key: RequestKey; readonly answer: Received }
  /** The clock reached `at`; every waiting policy is told. */
  | { readonly _tag: "Tick"; readonly message: Extract<PolicyMessage, { _tag: "Tick" }> };

export type GateOutput =
  /** Carry out this request. */
  | { readonly _tag: "Forward"; readonly request: EffectRequest }
  /** Give this observation to the core. */
  | { readonly _tag: "Observe"; readonly observation: Observation }
  /** The policy reviewing `key` asks for this to be answered. */
  | { readonly _tag: "Ask"; readonly key: RequestKey; readonly asks: Received };

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

function holding<State>(
  held: GateState<State>,
  key: RequestKey,
  entry: { readonly request: Reviewed; readonly state: State },
): GateState<State> {
  return { waiting: new Map([...held.waiting, [key, entry]]) };
}

function releasing<State>(held: GateState<State>, key: RequestKey): GateState<State> {
  return { waiting: new Map([...held.waiting].filter(([waiting]) => waiting !== key)) };
}

/** The gate after the policy reviewing `key` took `step`. */
function settle<State>(
  held: GateState<State>,
  key: RequestKey,
  request: Reviewed,
  step: PolicyStep<State>,
): GateStep<State> {
  switch (step._tag) {
    case "Waiting":
      return {
        gate: holding(held, key, { request, state: step.state }),
        outputs: step.asks === undefined ? [] : [{ _tag: "Ask", key, asks: step.asks }],
      };
    case "Decided":
      switch (step.verdict._tag) {
        case "Continue":
          return { gate: releasing(held, key), outputs: [{ _tag: "Forward", request }] };
        case "Veto":
          return {
            gate: releasing(held, key),
            outputs: [{ _tag: "Observe", observation: vetoed(request, step.verdict.reason) }],
          };
        default:
          return step.verdict satisfies never;
      }
    default:
      return step satisfies never;
  }
}

export function gate<State>(
  policy: Policy<State>,
  held: GateState<State>,
  input: GateInput,
): GateStep<State> {
  switch (input._tag) {
    case "Requested": {
      const request = input.request;
      return request._tag === "StartTurn"
        ? { gate: held, outputs: [{ _tag: "Forward", request }] }
        : settle(held, keyOf(request), request, policy.start(request));
    }
    case "Answered": {
      const waiting = held.waiting.get(input.key);
      return waiting === undefined
        ? { gate: held, outputs: [] }
        : settle(
            held,
            input.key,
            waiting.request,
            policy.receive(waiting.state, { _tag: "Answered", answer: input.answer }),
          );
    }
    case "Tick":
      return [...held.waiting].reduce<GateStep<State>>(
        (done, [key, waiting]) => {
          const next = settle(done.gate, key, waiting.request, policy.receive(waiting.state, input.message));
          return { gate: next.gate, outputs: [...done.outputs, ...next.outputs] };
        },
        { gate: held, outputs: [] },
      );
    default:
      return input satisfies never;
  }
}
