/**
 * A permission the core asks (`PermissionAsked`) as ACP's `session/request_permission`, and the
 * client's response as the answer the core records (`PermissionAnswered`). The options are the ones
 * the policy offered, by their kinds; the client picks one, or answers `cancelled`, which is the
 * refusal of this call alone (the policy's reject-once option): the turn goes on, and the model
 * decides what to do next.
 */

import { Data } from "effect";
import type { RequestPermissionRequest, RequestPermissionResponse, SessionId } from "../acp/schema/v1.gen.ts";
import { PermissionOptionId, ToolCallId } from "../acp/schema/v1.gen.ts";
import type { Received } from "../agent-machine/received.ts";
import { answerPicking, type PermissionQuestion } from "../agent-policy/permissions.ts";
import { parseJson } from "../agent-session/received.ts";
import type { Call, Presented } from "./projection.ts";

/** A response that picks no option the question offered; the host answers -32602. */
export class InvalidAnswer extends Data.TaggedError("InvalidAnswer")<{ readonly reason: string }> {}

/**
 * The `session/request_permission` for `call` in session `sessionId`: the call as the host presents
 * it, `pending`, with its input as given, and the options `question` offers.
 */
export function requestOf(sessionId: SessionId, call: Call, question: PermissionQuestion, presented: Presented): RequestPermissionRequest {
  const input = parseJson(call.input);
  return {
    sessionId,
    toolCall: {
      toolCallId: ToolCallId.make(call.call),
      title: presented.title,
      kind: presented.kind ?? question.kind,
      status: "pending",
      ...(presented.locations === undefined ? {} : { locations: presented.locations }),
      ...(presented.content === undefined ? {} : { content: presented.content }),
      ...("value" in input ? { rawInput: input.value } : {}),
    },
    options: question.options.map((option) => ({ optionId: PermissionOptionId.make(option.optionId), name: option.name, kind: option.kind })),
  };
}

/**
 * The answer `response` gives to `question`, as `PermissionAnswered` holds it: the option selected,
 * or, for `cancelled`, the option that rejects this call once.
 */
export function answerOf(response: RequestPermissionResponse, question: PermissionQuestion): Received | InvalidAnswer {
  const { outcome } = response;
  if (outcome.outcome === "cancelled") {
    const reject = question.options.find((option) => option.kind === "reject_once");
    return reject === undefined
      ? new InvalidAnswer({ reason: `The request was cancelled, and the question about ${question.tool} offers no option that rejects the call once.` })
      : answerPicking(reject.optionId);
  }
  const chosen: string = outcome.optionId;
  const picked = question.options.find((option) => option.optionId === chosen);
  return picked === undefined
    ? new InvalidAnswer({ reason: `${chosen} is not an option offered for ${question.tool}.` })
    : answerPicking(picked.optionId);
}
