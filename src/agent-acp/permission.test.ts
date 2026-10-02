/** A permission the policy asks as ACP's `session/request_permission`, and the client's response as the answer recorded. */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { PermissionOptionId, SessionId } from "../acp/schema/v1.gen.ts";
import { CallId, ToolName } from "../agent-machine/names.ts";
import type { Received } from "../agent-machine/received.ts";
import { OptionId, OptionName, type PermissionQuestion, permissions, questionIn } from "../agent-policy/permissions.ts";
import { receivedJson } from "../agent-session/received.ts";
import { answerOf, InvalidAnswer, requestOf } from "./permission.ts";

const call = { call: CallId.make("c1"), tool: ToolName.make("write_file"), input: receivedJson({ path: "a.ts", text: "hi" }) };

/** What the permission policy asks before a call to `write_file`, an edit, in `default` mode. */
const policy = permissions("default", true, () => "edit", []);
const asked = policy.start({ _tag: "RunTool", ...call });
const question = asked._tag === "Waiting" && asked.asks !== undefined ? questionIn(asked.asks) : undefined;
if (question === undefined) throw new Error("the policy asked nothing");

/** What the policy decides on `answer`: the call runs (`Continue`), or is refused (`Veto`). */
const decided = (answer: Received) => {
  if (asked._tag !== "Waiting") throw new Error("the policy asked nothing");
  const step = policy.receive(asked.state, { _tag: "Answered", answer });
  return step._tag === "Decided" ? step.verdict._tag : step._tag;
};

test("AA6: the request is the call as presented, pending, with its input, and exactly the options the policy offered, by kind", () => {
  const request = requestOf(SessionId.make("s1"), call, question, { title: "Write a.ts", kind: "edit", locations: [{ path: "/w/a.ts" }] });
  expect(request as unknown).toEqual({
    sessionId: "s1",
    toolCall: { toolCallId: "c1", title: "Write a.ts", kind: "edit", status: "pending", locations: [{ path: "/w/a.ts" }], rawInput: { path: "a.ts", text: "hi" } },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-session", name: "Allow write_file for the rest of the session", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
});

test("AA6: a question that offers rejecting for the session offers it to the client too; a presentation with no kind takes the question's", () => {
  const always: PermissionQuestion = {
    ...question,
    options: [...question.options, { optionId: OptionId.make("reject-session"), name: OptionName.make("Never"), kind: "reject_always" }],
  };
  const request = requestOf(SessionId.make("s1"), call, always, { title: "write_file" });
  expect(request.options.map((option) => option.kind)).toEqual(["allow_once", "allow_always", "reject_once", "reject_always"]);
  expect(request.toolCall.kind).toBe("edit");
});

test("AA7: the option selected is the answer that picks it; the policy takes it as the option says", () => {
  const picking = (optionId: string) => answerOf({ outcome: { outcome: "selected", optionId: PermissionOptionId.make(optionId) } }, question);
  const answers = ["allow-once", "allow-session", "reject-once"].map(picking);
  expect(answers.map((answer) => (answer instanceof InvalidAnswer ? answer : decided(answer)))).toEqual(["Continue", "Continue", "Veto"]);
});

test("AA7: a cancelled request is the refusal of this call alone: the reject-once option, not one that rejects for the session", () => {
  const always: PermissionQuestion = {
    ...question,
    options: [{ optionId: OptionId.make("reject-session"), name: OptionName.make("Never"), kind: "reject_always" }, ...question.options],
  };
  const answer = answerOf({ outcome: { outcome: "cancelled" } }, always);
  if (answer instanceof InvalidAnswer) throw answer;
  expect(answer.body).toEqual({ _tag: "Text", text: '{"optionId":"reject-once"}' } as never);
  expect(decided(answer)).toBe("Veto");
});

test("AA7: an option the question did not offer, or a cancel with no option to reject once, is an invalid answer", () => {
  const unknown = answerOf({ outcome: { outcome: "selected", optionId: PermissionOptionId.make("allow-forever") } }, question);
  const noReject: PermissionQuestion = { ...question, options: question.options.filter((option) => option.kind !== "reject_once") };
  const cancelled = answerOf({ outcome: { outcome: "cancelled" } }, noReject);
  expect([unknown, cancelled].map((answer) => (answer instanceof InvalidAnswer ? answer.reason : "valid"))).toEqual([
    "allow-forever is not an option offered for write_file.",
    "The request was cancelled, and the question about write_file offers no option that rejects the call once.",
  ]);
});
