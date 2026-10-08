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
import { markdownOf } from "../agent-host/command-detail.ts";
import { answerPicking, type CommandNeed, type Explained, explainedAt, type PermissionQuestion } from "../agent-policy/permissions.ts";
import { type Call, type Presented, rawOf } from "./projection.ts";

/** A response that picks no option the question offered; the host answers -32602. */
export class InvalidAnswer extends Data.TaggedError("InvalidAnswer")<{ readonly reason: string }> {}

/** Whether `content` has a diff of the file that `path` (as the command writes it) names: the same path, or one that ends with it. */
const diffed = (content: ReadonlyArray<ToolCallContent>, path: string): boolean => {
  const relative = path.replace(/^(\.\/|~\/)/, "");
  return content.some((each) => each.type === "diff" && (each.path === path || each.path.endsWith(`/${relative}`)));
};

/**
 * A need, as a Markdown list item: the program and why, then, on the first need of its program, its
 * detail indented under the item and its notes as a list. A write the call shows as a diff is named,
 * not repeated.
 */
const needShown =
  (content: ReadonlyArray<ToolCallContent>, explained: Explained) =>
  (need: CommandNeed, at: number, needs: ReadonlyArray<CommandNeed>): ReadonlyArray<string> => {
    const own = explainedAt(explained, needs, at);
    const detail = own?.detail;
    return [
      `- ${need.program}: ${need.why}`,
      ...(detail === undefined ? [] : ["", ...markdownOf(detail, detail._tag === "Writes" && diffed(content, detail.path)).map((line) => (line === "" ? "" : `  ${line}`))]),
      ...(own?.notes ?? []).map((note) => `  - ${note}`),
    ];
  };

/** A command question's reasons, as a Markdown text block: each program that needs permission, why, and what helps judge it, then the notes about the command. */
const needsBlock = (question: PermissionQuestion, content: ReadonlyArray<ToolCallContent>, explained: Explained): ReadonlyArray<ToolCallContent> => {
  if (question._tag === "Tool") return question.why === undefined ? [] : [{ type: "content", content: { type: "text", text: `This call needs permission: ${question.why}.` } }];
  return question._tag === "Command"
    ? [{ type: "content", content: { type: "text", text: ["This command needs permission:", "", ...question.needs.flatMap(needShown(content, explained)), ...explained.notes.flatMap((note) => ["", note])].join("\n") } }]
    : [];
};

const nothingExplained: Explained = { programs: [], notes: [] };

/**
 * Returns the `session/request_permission` for `call` in session `sessionId`: the call as the host
 * presents it, `pending`, with its input as `rawInput`, as the call's `tool_call` carried it
 * (`rawOf`), and the options that `question` offers. A question about a command adds to the call's
 * content a text block naming each program that needs permission and why, so that a client shows why
 * it is asked, with what `explained` (`explainedOf`, worked out from the command) says of each
 * program and of the command.
 */
export function requestOf(sessionId: SessionId, call: Call, question: PermissionQuestion, presented: Presented, explained: Explained = nothingExplained): RequestPermissionRequest {
  const input = rawOf(call.input);
  const content = [...(presented.content ?? []), ...needsBlock(question, presented.content ?? [], explained)];
  return {
    sessionId,
    toolCall: {
      toolCallId: ToolCallId.make(call.call),
      title: presented.title,
      kind: presented.kind ?? question.kind,
      status: "pending",
      ...(presented.locations === undefined ? {} : { locations: presented.locations }),
      ...(content.length === 0 ? {} : { content }),
      ...(input === undefined ? {} : { rawInput: input.value }),
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
