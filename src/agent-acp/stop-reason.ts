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
 */

import { Array as Arr, Option, Schema } from "effect";
import { ErrorCode, type JsonRpcErrorObject } from "effective-acp/json-rpc";
import type { StopReason } from "effective-acp/schema/v1";
import type { Ending } from "../agent-machine/decision.ts";
import type { Fact } from "../agent-machine/fact.ts";
import type { TurnId } from "../agent-machine/names.ts";
import { asText, parseJson } from "../agent-session/received.ts";

export type Stop = { readonly stopReason: StopReason } | { readonly error: JsonRpcErrorObject };

/** The reason the turn-request limit records (`agent-policy/max-turn-requests.ts`); it may say more. */
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

/** The answer to the prompt that began `turn`, as `facts` have it ended; none while it has not ended. */
export function stopOf(facts: ReadonlyArray<Fact>, turn: TurnId): Stop | undefined {
  const ended = facts.find((fact) => fact._tag === "Decided" && fact.decision._tag === "TurnEnded" && fact.decision.turn === turn);
  if (ended?._tag !== "Decided" || ended.decision._tag !== "TurnEnded") return undefined;
  const last = Option.getOrUndefined(Arr.findLast(facts, (fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded" && fact.observation.turn === turn));
  const refused = last?._tag === "Observed" && last.observation._tag === "ModelResponded" && last.observation.ending._tag === "Refused";
  return refused ? { stopReason: "refusal" } : stopFor(ended.decision.ending);
}
