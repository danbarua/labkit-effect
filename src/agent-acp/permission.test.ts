/** A permission the policy asks as ACP's `session/request_permission`, and the client's response as the answer recorded. */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { TerminalId, PermissionOptionId, SessionId } from "effective-acp/schema/v1";
import { CallId, ToolName } from "../agent-machine/names.ts";
import type { Received } from "../agent-machine/received.ts";
import { OptionId, OptionName, type PermissionQuestion, permissions, questionIn } from "../agent-policy/permissions.ts";
import { receivedJson } from "../agent-session/received.ts";
import { ShellCommand, WordText } from "../agent-policy/command-segments.ts";
import { CodeText, NeedText } from "../agent-policy/command-units.ts";
import { Explanation } from "../agent-policy/sed-script.ts";
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

test("the request is the call as presented, pending, with its input, and exactly the options the policy offered, by kind", () => {
  const request = requestOf(SessionId.make("s1"), call, question, { title: "Write a.ts", kind: "edit", locations: [{ path: "/w/a.ts" }] });
  expect(request as unknown).toEqual({
    sessionId: "s1",
    toolCall: { toolCallId: "c1", title: "Write a.ts", kind: "edit", status: "pending", locations: [{ path: "/w/a.ts" }], rawInput: { path: "a.ts", text: "hi" } },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-session", name: "Allow write_file for the rest of the session", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      { optionId: "reject-session", name: "Reject write_file for the rest of the session", kind: "reject_always" },
    ],
  });
});

test("the policy's option that rejects for the session is offered to the client too; a presentation with no kind takes the question's", () => {
  const request = requestOf(SessionId.make("s1"), call, question, { title: "write_file" });
  expect(request.options.map((option) => option.kind)).toEqual(["allow_once", "allow_always", "reject_once", "reject_always"]);
  expect(request.toolCall.kind).toBe("edit");
});

test("the option selected is the answer that picks it; the policy takes it as the option says", () => {
  const picking = (optionId: string) => answerOf({ outcome: { outcome: "selected", optionId: PermissionOptionId.make(optionId) } }, question);
  const answers = ["allow-once", "allow-session", "reject-once"].map(picking);
  expect(answers.map((answer) => (answer instanceof InvalidAnswer ? answer : decided(answer)))).toEqual(["Continue", "Continue", "Veto"]);
});

test("a cancelled request is the refusal of this call alone: the reject-once option, not one that rejects for the session", () => {
  const always: PermissionQuestion = {
    ...question,
    options: [{ optionId: OptionId.make("reject-session"), name: OptionName.make("Never"), kind: "reject_always" }, ...question.options],
  };
  const answer = answerOf({ outcome: { outcome: "cancelled" } }, always);
  if (answer instanceof InvalidAnswer) throw answer;
  expect(answer.body).toEqual({ _tag: "Text", text: '{"optionId":"reject-once"}' } as never);
  expect(decided(answer)).toBe("Veto");
});

test("an option the question did not offer, or a cancel with no option to reject once, is an invalid answer", () => {
  const unknown = answerOf({ outcome: { outcome: "selected", optionId: PermissionOptionId.make("allow-forever") } }, question);
  const noReject: PermissionQuestion = { ...question, options: question.options.filter((option) => option.kind !== "reject_once") };
  const cancelled = answerOf({ outcome: { outcome: "cancelled" } }, noReject);
  expect([unknown, cancelled].map((answer) => (answer instanceof InvalidAnswer ? answer.reason : "valid"))).toEqual([
    "allow-forever is not an option offered for write_file.",
    "The request was cancelled, and the question about write_file offers no option that rejects the call once.",
  ]);
});

test("a question about a command adds to the call's content a text block naming each program that needs permission and why", () => {
  const command: PermissionQuestion = {
    _tag: "Command",
    tool: ToolName.make("terminal_command"),
    kind: "execute",
    options: [],
    command: ShellCommand.make("git log; rm -rf build"),
    needs: [{ program: WordText.make("rm -rf build"), why: NeedText.make("it is not allowed yet") }],
    grants: [],
  };
  const presented = { title: "Clean the build", kind: "execute" as const, content: [{ type: "terminal" as const, terminalId: TerminalId.make("t1") }] };
  expect(requestOf(SessionId.make("s1"), call, command, presented).toolCall.content as unknown).toEqual([
    { type: "terminal", terminalId: "t1" },
    { type: "content", content: { type: "text", text: "This command needs permission:\n\n- rm -rf build: it is not allowed yet" } },
  ]);
  expect(requestOf(SessionId.make("s1"), call, question, { title: "Write a.ts", kind: "edit" }).toolCall.content).toBeUndefined();
});

test("a need's detail is Markdown indented under its item: code in a fence that names its language, an explanation as a nested list", () => {
  const command: PermissionQuestion = {
    _tag: "Command",
    tool: ToolName.make("terminal_command"),
    kind: "execute",
    options: [],
    command: ShellCommand.make("python3 -c 'print(1)'; sed -n /x/p f"),
    needs: [
      { program: WordText.make("python3 -c print(1)"), why: NeedText.make("it runs code written in the command"), detail: { _tag: "Code", language: "python", code: CodeText.make("import sys\nprint(1)") } },
      {
        program: WordText.make("sed -n /x/p f"),
        why: NeedText.make("it is not allowed yet"),
        detail: { _tag: "Explained", lines: [{ depth: 0, text: Explanation.make("Reads f:") }, { depth: 1, text: Explanation.make("Prints lines matching `x`.") }] },
      },
    ],
    grants: [],
  };
  const content = requestOf(SessionId.make("s1"), call, command, { title: "Run" }).toolCall.content;
  expect(content as unknown).toEqual([
    {
      type: "content",
      content: {
        type: "text",
        text: [
          "This command needs permission:",
          "",
          "- python3 -c print(1): it runs code written in the command",
          "",
          "  ```python",
          "  import sys",
          "  print(1)",
          "  ```",
          "- sed -n /x/p f: it is not allowed yet",
          "",
          "  Reads f:",
          "  - Prints lines matching `x`.",
        ].join("\n"),
      },
    },
  ]);
});
