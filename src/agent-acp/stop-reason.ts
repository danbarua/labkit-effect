/**
 * How a turn ended, as ACP's answer to the `session/prompt` that began it: a `stopReason`, or a
 * JSON-RPC error.
 *
 * | Ending | Answer |
 * |---|---|
 * | `Completed`, `Incomplete` | `end_turn` |
 * | `CutShort` | `max_tokens` |
 * | `Interrupted` | `cancelled` |
 * | `Vetoed` by the turn-request limit (its reason's JSON has `stop: "max_turn_requests"`) | `max_turn_requests` |
 * | `Vetoed` otherwise | an error carrying the reason |
 * | `Failed` | an error carrying the failure |
 * | any, when the turn's last response was `Refused` | `refusal` |
 *
 * A turn that stops with `max_tokens` or `refusal` is explained by a `notice` (`noticeOf`), from the
 * same facts: the user sees why the reply stopped, which the stop reason alone does not say.
 */

import { Array as Arr, Effect, Option, Schema } from "effect";
import { ErrorCode, type JsonRpcErrorObject } from "effective-acp/json-rpc";
import type { SessionUpdate, StopReason } from "effective-acp/schema/v1";
import type { Ending } from "../agent-machine/decision.ts";
import type { Fact } from "../agent-machine/fact.ts";
import type { TurnId } from "../agent-machine/names.ts";
import type { Observation } from "../agent-machine/observation.ts";
import { modelOf } from "../agent-session/configuration/session-setup.ts";
import { asText, parseJson } from "../agent-session/received.ts";

export type Stop = { readonly stopReason: StopReason } | { readonly error: JsonRpcErrorObject };

/** The reason that the turn-request limit records (`agent-policy/max-turn-requests.ts`). The reason may hold more fields. */
const isTurnLimit = Schema.is(Schema.Struct({ stop: Schema.Literal("max_turn_requests") }));

const stopFor = (ending: Ending): Stop => {
  switch (ending._tag) {
    case "Completed":
    case "Incomplete":
      return { stopReason: "end_turn" };
    case "CutShort":
      return { stopReason: "max_tokens" };
    case "Interrupted":
      return { stopReason: "cancelled" };
    case "Vetoed": {
      const parsed = parseJson(ending.reason);
      return "value" in parsed && isTurnLimit(parsed.value)
        ? { stopReason: "max_turn_requests" }
        : { error: { code: ErrorCode.InternalError, message: asText(ending.reason) } };
    }
    case "Failed":
      return { error: { code: ErrorCode.InternalError, message: ending.failure } };
    default:
      return ending satisfies never;
  }
};

type Response = Extract<Observation, { _tag: "ModelResponded" }>;

/** Returns the turn's last response, with the position of its fact; undefined when the turn has none. */
const lastResponseOf = (facts: ReadonlyArray<Fact>, turn: TurnId): { readonly seq: number; readonly response: Response } | undefined => {
  const last = Option.getOrUndefined(Arr.findLast(facts, (fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded" && fact.observation.turn === turn));
  return last?._tag === "Observed" && last.observation._tag === "ModelResponded" ? { seq: last.seq, response: last.observation } : undefined;
};

/** Returns the answer to the prompt that began `turn`, from the ending that `facts` record; undefined while the turn has not ended. */
export function stopOf(facts: ReadonlyArray<Fact>, turn: TurnId): Stop | undefined {
  const ended = facts.find((fact) => fact._tag === "Decided" && fact.decision._tag === "TurnEnded" && fact.decision.turn === turn);
  if (ended?._tag !== "Decided" || ended.decision._tag !== "TurnEnded") return undefined;
  const refused = lastResponseOf(facts, turn)?.response.ending._tag === "Refused";
  return refused ? { stopReason: "refusal" } : stopFor(ended.decision.ending);
}

/** A `notice` session update. */
export type StopNotice = Extract<SessionUpdate, { readonly sessionUpdate: "notice" }>;

/**
 * Returns the text of every field named `refusal` in `value`. OpenAI's Responses API (a message's
 * `{ type: "refusal", refusal }` content) and Chat Completions (a message's `refusal`) carry a
 * refusal's words there, and their adapters keep such content whole in an `Unrecognised` part.
 */
const refusalsIn = (value: Schema.Json): ReadonlyArray<string> => {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return (value as ReadonlyArray<Schema.Json>).flatMap(refusalsIn);
  return Object.entries(value as { readonly [key: string]: Schema.Json }).flatMap(([key, each]) => {
    if (key !== "refusal" || typeof each !== "string") return refusalsIn(each);
    return each.trim() === "" ? [] : [each];
  });
};

/** Returns the refusal text that `response` carries, in its own words. */
const refusalTextOf = (response: Response): ReadonlyArray<string> =>
  response.parts.flatMap((part) => {
    if (part._tag !== "Unrecognised") return [];
    const parsed = parseJson(part.received);
    return "value" in parsed ? refusalsIn(parsed.value) : [];
  });

const tokens = (count: number): string => count.toLocaleString("en-US");

/**
 * Returns the output limit that the request for `response` was sent with: the session's
 * `maxOutputTokens` for the model, as its facts record it before the response, adjustments included.
 * Undefined when the settings give none (an adapter's own default is not recorded) or when the
 * response came from another model than the session asked (a fallback's limit is not recorded).
 */
const limitOf = (facts: ReadonlyArray<Fact>, seq: number, response: Response): Effect.Effect<number | undefined> =>
  Effect.map(modelOf(facts.filter((fact) => fact.seq < seq)), (target) =>
    target.provider === response.provider && target.model === response.model ? target.settings?.maxOutputTokens : undefined,
  );

/**
 * Returns the notice that explains a prompt's stop to the user: for `max_tokens`, that the reply was
 * cut short, and for `refusal`, that the model declined to continue; undefined for any other stop.
 * It says only what the turn's last response and the session's settings record: the model; for a
 * reply cut short, whether a length limit stopped it, the output tokens the response used and the
 * output limit the request was sent with; for a refusal, the provider's own stop reason and any
 * refusal text the response carries, quoted.
 */
export const noticeOf = (facts: ReadonlyArray<Fact>, turn: TurnId, stopReason: StopReason): Effect.Effect<StopNotice | undefined> =>
  Effect.gen(function* () {
    if (stopReason !== "max_tokens" && stopReason !== "refusal") return undefined;
    const title = stopReason === "max_tokens" ? "The reply was cut short" : "The model declined to continue";
    const last = lastResponseOf(facts, turn);
    if (last === undefined) return { sessionUpdate: "notice", severity: "warning", title };
    const { response } = last;
    const model = `${response.provider}/${response.model}`;
    const reason = response.stop === undefined ? [] : [`The provider's stop reason: ${response.stop}.`];
    if (stopReason === "refusal") {
      const said = refusalTextOf(response).map((text) => `It said: "${text}"`);
      return { sessionUpdate: "notice", severity: "warning", title, description: [`${model} declined to continue.`, ...reason, ...said].join(" ") };
    }
    // A turn ends CutShort too after a response whose ending was not classified or not observed: only a CutShort response was stopped by a length limit.
    const how = response.ending._tag === "CutShort" ? "stopped at a length limit" : "stopped before finishing its reply";
    const used = response.usage === undefined ? "" : ` after ${tokens(response.usage.output)} output tokens`;
    const limit = yield* limitOf(facts, last.seq, response);
    const set = limit === undefined ? [] : [`The request set the output limit to ${tokens(limit)} tokens.`];
    return { sessionUpdate: "notice", severity: "warning", title, description: [`${model} ${how}${used}.`, ...set, ...reason].join(" ") };
  });
