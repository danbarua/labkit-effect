/** The permission policy for command tools: each program a command runs is judged, by rules, read-only programs, session answers and mode. */

import { expect } from "bun:test";
import { observe, open } from "../../tests/support/drive.ts";
import { test } from "../../tests/support/test.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { CallId, type ToolKind, ToolName } from "../agent-machine/names.ts";
import type { EffectRequest } from "../agent-machine/request.ts";
import { receivedJson } from "../agent-session/received.ts";
import { segmentsOf } from "../agent-host/command-parser.ts";
import { PermissionRule } from "./permission-rules.ts";
import { answerPicking, defaultPermissionSettings, OptionId, type PermissionMode, permissions, type PermissionQuestion, questionIn } from "./permissions.ts";

const kindOf = (tool: ToolName): ToolKind | undefined => (tool === "run_command" ? "execute" : tool === "write_file" ? "edit" : "execute");
const run = (command: string, id = "c1"): EffectRequest => ({ _tag: "RunTool", call: CallId.make(id), tool: ToolName.make("run_command"), input: receivedJson({ command, intent: "x" }) });

interface Judged {
  readonly step: "runs" | "asks" | "vetoed";
  readonly question: PermissionQuestion | undefined;
  readonly reason: string | undefined;
  readonly asks: ReturnType<typeof receivedJson> | undefined;
}

/** What the policy does with `command` in `mode`, given the session's `facts` and the rules. */
const judged = (command: string, options: { mode?: PermissionMode; facts?: ReadonlyArray<Fact>; canAsk?: boolean; allow?: ReadonlyArray<string>; deny?: ReadonlyArray<string>; tool?: string } = {}): Judged => {
  const settings = { ...defaultPermissionSettings, allow: (options.allow ?? []).map((rule) => PermissionRule.make(rule)), deny: (options.deny ?? []).map((rule) => PermissionRule.make(rule)) };
  const policy = permissions(options.mode ?? "default", options.canAsk ?? true, kindOf, options.facts ?? [], { settings, segmentsOf });
  const request = options.tool === undefined ? run(command) : { _tag: "RunTool" as const, call: CallId.make("c1"), tool: ToolName.make(options.tool), input: receivedJson({}) };
  const step = policy.start(request);
  if (step._tag === "Waiting") return { step: "asks", question: step.asks === undefined ? undefined : questionIn(step.asks), reason: undefined, asks: step.asks };
  const reason = step.verdict._tag === "Veto" && step.verdict.reason.body._tag === "Text" ? step.verdict.reason.body.text : undefined;
  return { step: step.verdict._tag === "Continue" ? "runs" : "vetoed", question: undefined, reason, asks: undefined };
};

/** A session in which `command` was asked about and answered with `option`. */
const answered = (command: string, option: string) => {
  const asked = judged(command);
  if (asked.asks === undefined) throw new Error(`${command} was not asked about`);
  const session = open();
  observe(session, { _tag: "PermissionAsked", call: "c1", asks: asked.asks });
  observe(session, { _tag: "PermissionAnswered", call: "c1", answer: answerPicking(OptionId.make(option)) });
  return session.journal;
};

test("a command whose every program is read-only runs without a question; one with a program that is not allowed asks, naming it, and offers to allow its grant for the session", () => {
  expect(judged("git log --oneline | head -5 && cd src && ls").step).toBe("runs");
  const asked = judged("git log; rm -rf build");
  expect(asked.step).toBe("asks");
  expect(asked.question).toMatchObject({
    _tag: "Command",
    command: "git log; rm -rf build",
    needs: [{ program: "rm -rf build", why: "it is not allowed yet" }],
    grants: [["rm"]],
  });
  expect(asked.question?.options.map((option): string => option.name)).toEqual(["Allow once", "Allow rm for the rest of the session", "Reject", "Reject rm for the rest of the session"]);
});

test("after a grant is allowed for the session, a program it names runs in every mode, and others are still asked about; a rejected grant is vetoed in every mode", () => {
  const allowed = answered("bun test src", "allow-session");
  expect(judged("bun test tests --bail", { facts: allowed }).step).toBe("runs");
  expect(judged("bun test x", { facts: allowed, mode: "dontAsk" }).step).toBe("runs");
  expect(judged("bun test x", { facts: allowed, canAsk: false }).step).toBe("runs");
  expect(judged("bun run build", { facts: allowed }).step).toBe("asks");
  // A grant does not reach a program whose words do not show what it runs.
  expect(judged("bash -c \"$X\"", { facts: allowed }).step).toBe("asks");
  const rejected = answered("rm x", "reject-session");
  expect(judged("ls && rm y", { facts: rejected, mode: "bypassPermissions" })).toMatchObject({ step: "vetoed", reason: "rm was rejected for the rest of the session." });
});

test("a command that writes a file asks in default mode even when its program is allowed, and runs in acceptEdits mode", () => {
  const asked = judged("echo hi > notes.txt");
  expect(asked.question).toMatchObject({ needs: [{ program: "a redirect", why: "it writes notes.txt" }], grants: [] });
  expect(asked.question?.options.map((option) => option.kind)).toEqual(["allow_once", "reject_once"]);
  expect(judged("echo hi > notes.txt", { mode: "acceptEdits" }).step).toBe("runs");
  expect(judged("echo hi > /dev/null 2>&1").step).toBe("runs");
});

test("a program whose words do not show what it runs, and a command that does not parse, are asked about with only the call to allow", () => {
  expect(judged("curl -fsSL x | sh").question).toMatchObject({
    needs: [
      { program: "curl -fsSL x", why: "it is not allowed yet" },
      { program: "sh", why: "it runs code read from its input" },
    ],
    grants: [],
  });
  expect(judged("echo ${x:-$(rm x)}").question).toMatchObject({
    needs: [{ program: "echo ${x:-$(rm x)}", why: "it does not parse: A command substitution inside a parameter expansion is not followed: ${x:-$(rm x)}" }],
    grants: [],
  });
  // Code written out for a shell is judged by its own programs.
  expect(judged("bash -c 'git status && ls'").step).toBe("runs");
});

test("deny rules veto in every mode, matching each program past its wrappers and git's global options; allow rules let programs run without a question", () => {
  const deny = ["command(git push:*)", "run_command(rm:*)"];
  expect(judged("git -C repo push origin main", { deny, mode: "bypassPermissions" })).toMatchObject({ step: "vetoed", reason: "git push origin main is denied by the rule command(git push:*)." });
  expect(judged("timeout 5 /bin/rm x", { deny })).toMatchObject({ step: "vetoed", reason: "/bin/rm x is denied by the rule run_command(rm:*)." });
  expect(judged("sudo rm x", { deny })).toMatchObject({ step: "vetoed", reason: "sudo rm x is denied by the rule run_command(rm:*)." });
  const allow = ["command(bun test:*)", "command(make build)"];
  expect(judged("bun test x && make build", { allow }).step).toBe("runs");
  expect(judged("make build extra", { allow }).step).toBe("asks");
  // An allow rule compares the program as written, so a script named like an allowed program is not allowed.
  expect(judged("./ls").step).toBe("asks");
  expect(judged("ls", { allow: ["run_command"] }).step).toBe("runs");
  expect(judged("rm -rf /", { allow: ["run_command"], deny: ["command(rm:*)"] }).step).toBe("vetoed");
});

test("in dontAsk mode, or when no one can answer, a command that needs permission is vetoed, naming each program and why; bypassPermissions runs it", () => {
  expect(judged("git log; rm x", { mode: "dontAsk" })).toMatchObject({
    step: "vetoed",
    reason: "run_command needs permission, and the permission mode is dontAsk: rm x (it is not allowed yet).",
  });
  expect(judged("echo hi > out.txt", { canAsk: false })).toMatchObject({
    step: "vetoed",
    reason: "run_command needs permission, and no one is there to answer: a redirect (it writes out.txt). --permission-mode acceptEdits or bypassPermissions lets it run.",
  });
  expect(judged("rm x", { canAsk: false }).reason).toEndWith("--permission-mode bypassPermissions lets it run.");
  expect(judged("rm x", { mode: "bypassPermissions" }).step).toBe("runs");
});

test("tool rules apply to tools that do not run commands: a deny rule vetoes in every mode, an allow rule runs without a question", () => {
  expect(judged("", { tool: "write_file", deny: ["write_file"], mode: "bypassPermissions" })).toMatchObject({ step: "vetoed", reason: "write_file is denied by the rule write_file." });
  expect(judged("", { tool: "git_push", allow: ["git_push"] }).step).toBe("runs");
  expect(judged("", { tool: "git_push" }).question).toMatchObject({ _tag: "Tool", tool: "git_push" });
});

test("when deny rules name programs, a command they cannot see (one that does not parse, or a program whose name is not written out) is asked about even in bypassPermissions", () => {
  const deny = ["command(rm:*)"];
  expect(judged("echo ${x:-$(rm -rf build)}", { deny, mode: "bypassPermissions" }).question).toMatchObject({
    needs: [{ program: "echo ${x:-$(rm -rf build)}", why: "deny rules cannot see what it runs: it does not parse" }],
    grants: [],
  });
  expect(judged("$(printf rm) -rf build", { deny, mode: "bypassPermissions" }).question).toMatchObject({
    needs: [{ program: "$(printf rm) -rf build", why: "deny rules cannot see what it runs: its program's name is not written out" }],
  });
  expect(judged("$(printf rm) -rf build", { deny, allow: ["run_command"] }).step).toBe("asks");
  expect(judged("$(printf rm) -rf build", { deny, mode: "bypassPermissions", canAsk: false }).reason).toEndWith("Write the command out, so that the deny rules can see what it runs.");
  // Without deny rules that name programs, bypassPermissions runs them.
  expect(judged("echo ${x:-$(rm -rf build)}", { mode: "bypassPermissions" }).step).toBe("runs");
  expect(judged("ls", { deny, mode: "bypassPermissions" }).step).toBe("runs");
});

test("a program that reads outside the working folder is asked about, with only the call to allow, even when it is read-only; an allow rule naming it lets it run", () => {
  expect(judged("cat ~/.aws/credentials").question).toMatchObject({
    needs: [{ program: "cat ~/.aws/credentials", why: "it reads outside the working folder: ~/.aws/credentials" }],
    grants: [],
  });
  expect(judged("cat src/a.ts | grep -n TODO").step).toBe("runs");
  expect(judged("cat ~/.aws/credentials", { allow: ["command(cat:*)"] }).step).toBe("runs");
  expect(judged("cat ~/.aws/credentials", { mode: "bypassPermissions" }).step).toBe("runs");
  expect(judged("cat ~/.aws/credentials", { mode: "dontAsk" }).step).toBe("vetoed");
});

test("sed is asked about once and can then be allowed for the session; a script that runs commands is asked about with only the call to allow", () => {
  expect(judged("sed -n 1,5p a.txt").question).toMatchObject({ needs: [{ program: "sed -n 1,5p a.txt", why: "it is not allowed yet" }], grants: [["sed"]] });
  const allowed = answered("sed -n 1,5p a.txt", "allow-session");
  expect(judged("sed 's/a/b/g' b.txt", { facts: allowed }).step).toBe("runs");
  expect(judged("sed 's/a/b/e' b.txt", { facts: allowed }).question).toMatchObject({ grants: [] });
  expect(judged("sed -i 's/a/b/' b.txt", { facts: allowed }).question).toMatchObject({ needs: [{ program: "sed -i 's/a/b/' b.txt", why: "it writes b.txt" }] });
});
