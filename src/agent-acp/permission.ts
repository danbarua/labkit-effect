/**
 * Converts a permission question that the core records (`PermissionAsked`) to ACP's
 * `session/request_permission`, and the client's response to the answer that the core records
 * (`PermissionAnswered`). The options are the ones the policy offered, with their kinds. The client
 * picks one, or answers `cancelled`, which refuses this call alone (the policy's reject-once
 * option): the turn goes on, and the model decides what to do next.
 */

import { Data } from "effect";
import type { RequestPermissionRequest, RequestPermissionResponse, SessionId, ToolCallContent } from "effective-acp/schema/v1";
import { PermissionOptionId, ToolCallId } from "effective-acp/schema/v1";
import type { Received } from "../agent-machine/received.ts";
import { answerPicking, type PermissionQuestion } from "../agent-policy/permissions.ts";
import { parseJson } from "../agent-session/received.ts";
import type { Call, Presented } from "./projection.ts";

/** A response that picks no option the question offered; the host answers -32602. */
export class InvalidAnswer extends Data.TaggedError("InvalidAnswer")<{ readonly reason: string }> {}

/** A command question's reasons, as a text block: each program that needs permission, and why. */
const needsBlock = (question: PermissionQuestion): ReadonlyArray<ToolCallContent> =>
  question._tag === "Command"
    ? [{ type: "content", content: { type: "text", text: ["This command needs permission:", ...question.needs.map((each) => `- ${each.program}: ${each.why}`)].join("\n") } }]
    : [];

/**
 * Returns the `session/request_permission` for `call` in session `sessionId`: the call as the host
 * presents it, `pending`, with its input as `rawInput`, and the options that `question` offers. A
 * question about a command adds to the call's content a text block naming each program that needs
 * permission and why, so that a client shows why it is asked.
 */
export function requestOf(sessionId: SessionId, call: Call, question: PermissionQuestion, presented: Presented): RequestPermissionRequest {
  const input = parseJson(call.input);
  const content = [...(presented.content ?? []), ...needsBlock(question)];
  return {
    sessionId,
    toolCall: {
      toolCallId: ToolCallId.make(call.call),
      title: presented.title,
      kind: presented.kind ?? question.kind,
      status: "pending",
      ...(presented.locations === undefined ? {} : { locations: presented.locations }),
      ...(content.length === 0 ? {} : { content }),
      ...("value" in input ? { rawInput: input.value } : {}),
    },
    options: question.options.map((option) => ({ optionId: PermissionOptionId.make(option.optionId), name: option.name, kind: option.kind })),
  };
}

/**
 * Returns the answer that `response` gives to `question`, as `PermissionAnswered` records it: the
 * option selected, or, for `cancelled`, the option that rejects this call once.
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
