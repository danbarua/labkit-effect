/** A permission the policy asks as ACP's `session/request_permission`, and the client's response as the answer recorded. */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { TerminalId, PermissionOptionId, SessionId } from "effective-acp/schema/v1";
import { CallId, FailureText, ToolName } from "../agent-machine/names.ts";
import type { Received } from "../agent-machine/received.ts";
import { type Explained, type PermissionQuestion, permissions, questionIn } from "../agent-policy/permissions.ts";
import { asText, receivedJson } from "../agent-session/received.ts";
import { ShellCommand, WordText } from "../agent-policy/command-segments.ts";
import { CodeText, NeedText } from "../agent-policy/command-units.ts";
import { Explanation } from "../agent-policy/sed-script.ts";
import { answerOf, requestOf } from "./permission.ts";

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
  const picking = (optionId: string) => answerOf({ outcome: { outcome: "selected", optionId: PermissionOptionId.make(optionId) } });
  expect(["allow-once", "allow-session", "reject-once"].map((optionId) => decided(picking(optionId)))).toEqual(["Continue", "Continue", "Veto"]);
  expect(picking("reject-once").body).toEqual({ _tag: "Text", text: '{"outcome":"selected","optionId":"reject-once"}' } as never);
});

test("a cancelled request is recorded as cancelled, as ACP gives it, not as an option selected; the policy vetoes the call", () => {
  const answer = answerOf({ outcome: { outcome: "cancelled" } });
  expect(answer.body).toEqual({ _tag: "Text", text: '{"outcome":"cancelled"}' } as never);
  expect(decided(answer)).toBe("Veto");
});

test("an option the question did not offer is recorded as the client selected it, and the policy vetoes the call", () => {
  const unknown = answerOf({ outcome: { outcome: "selected", optionId: PermissionOptionId.make("allow-forever") } });
  expect(unknown.body).toEqual({ _tag: "Text", text: '{"outcome":"selected","optionId":"allow-forever"}' } as never);
  expect(decided(unknown)).toBe("Veto");
});

test("a question that could not be asked vetoes the call, saying what failed", () => {
  if (asked._tag !== "Waiting") throw new Error("the policy asked nothing");
  const step = policy.receive(asked.state, { _tag: "AskingFailed", problem: FailureText.make("The connection closed.") });
  expect(step).toMatchObject({ _tag: "Decided", verdict: { _tag: "Veto" } });
  expect(step._tag === "Decided" && step.verdict._tag === "Veto" ? asText(step.verdict.reason) : undefined).toBe("The question about this call to write_file could not be asked: The connection closed.");
});

test("a question about a command adds to the call's content a text block naming each program that needs permission and why", () => {
  const command: PermissionQuestion = {
    _tag: "Command",
    tool: ToolName.make("terminal_command"),
    kind: "execute",
    options: [],
    command: ShellCommand.make("git log; rm -rf build"),
    needs: [{ program: WordText.make("rm -rf build"), kind: "notAllowed", why: NeedText.make("it is not allowed yet") }],
    grants: [],
  };
  const presented = { title: "Clean the build", kind: "execute" as const, content: [{ type: "terminal" as const, terminalId: TerminalId.make("t1") }] };
  expect(requestOf(SessionId.make("s1"), call, command, presented).toolCall.content as unknown).toEqual([
    { type: "terminal", terminalId: "t1" },
    { type: "content", content: { type: "text", text: "This command needs permission:\n\n- `rm -rf build`: it is not allowed yet" } },
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
      { program: WordText.make("python3 -c print(1)"), kind: "opaque", why: NeedText.make("it runs code written in the command") },
      { program: WordText.make("sed -n /x/p f"), kind: "notAllowed", why: NeedText.make("it is not allowed yet") },
    ],
    grants: [],
  };
  const explained: Explained = {
    programs: [
      { program: WordText.make("python3 -c print(1)"), detail: { _tag: "Code", language: "python", code: CodeText.make("import sys\nprint(1)") }, notes: [] },
      {
        program: WordText.make("sed -n /x/p f"),
        detail: { _tag: "Explained", lines: [{ depth: 0, text: Explanation.make("Reads `f`:") }, { depth: 1, text: Explanation.make("Prints lines matching `x`.") }] },
        notes: [],
      },
    ],
    notes: [],
  };
  const content = requestOf(SessionId.make("s1"), call, command, { title: "Run" }, explained).toolCall.content;
  expect(content as unknown).toEqual([
    {
      type: "content",
      content: {
        type: "text",
        text: [
          "This command needs permission:",
          "",
          "- `python3 -c print(1)`: it runs code written in the command",
          "",
          "  ```python",
          "  import sys",
          "  print(1)",
          "  ```",
          "- `sed -n /x/p f`: it is not allowed yet",
          "",
          "  Reads `f`:",
          "  - Prints lines matching `x`.",
        ].join("\n"),
      },
    },
  ]);
});

test("a write that the call shows as a diff is named in the question, not repeated; one it does not is shown as the text it writes", () => {
  const writing: PermissionQuestion = {
    _tag: "Command",
    tool: ToolName.make("terminal_command"),
    kind: "execute",
    options: [],
    command: ShellCommand.make("cat > config.yml <<'EOF' …"),
    needs: [{ program: WordText.make("a redirect"), kind: "writes", why: NeedText.make("it writes config.yml") }],
    grants: [],
  };
  const explained: Explained = {
    programs: [{ program: WordText.make("a redirect"), detail: { _tag: "Writes", path: WordText.make("config.yml"), text: CodeText.make("name: x\n"), append: false, expands: false }, notes: [] }],
    notes: [],
  };
  const diff = { type: "diff" as const, path: "/w/config.yml", oldText: "name: old\n", newText: "name: x\n" };
  const textOf = (content: ReadonlyArray<unknown> | null | undefined) => JSON.stringify(content?.at(-1));
  expect(requestOf(SessionId.make("s1"), call, writing, { title: "Write", content: [diff] }, explained).toolCall.content?.[0]).toEqual(diff);
  expect(textOf(requestOf(SessionId.make("s1"), call, writing, { title: "Write", content: [diff] }, explained).toolCall.content)).toContain("The diff shows what it writes to `config.yml`.");
  expect(textOf(requestOf(SessionId.make("s1"), call, writing, { title: "Write" }, explained).toolCall.content)).toContain("It writes this text to `config.yml`:\\n  ```\\n  name: x\\n  ```");
});

test("a need's notes are a list under its item, and the question's notes are paragraphs after the list", () => {
  const noted: PermissionQuestion = {
    _tag: "Command",
    tool: ToolName.make("terminal_command"),
    kind: "execute",
    options: [],
    command: ShellCommand.make("rm -rf build"),
    needs: [{ program: WordText.make("rm -rf build"), kind: "notAllowed", why: NeedText.make("it is not allowed yet") }],
    grants: [],
  };
  const explained: Explained = {
    programs: [{ program: WordText.make("rm -rf build"), detail: undefined, notes: [Explanation.make("It deletes the files and folders it names.")] }],
    notes: [Explanation.make("Allowing rm for the rest of the session lets later rm commands run without a question inside the working folder.")],
  };
  expect(requestOf(SessionId.make("s1"), call, noted, { title: "Clean" }, explained).toolCall.content as unknown).toEqual([
    {
      type: "content",
      content: {
        type: "text",
        text: [
          "This command needs permission:",
          "",
          "- `rm -rf build`: it is not allowed yet",
          "  - It deletes the files and folders it names.",
          "",
          "Allowing rm for the rest of the session lets later rm commands run without a question inside the working folder.",
        ].join("\n"),
      },
    },
  ]);
});
