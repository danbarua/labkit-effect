/** The permission policy for command tools: each program a command runs is judged, by rules, read-only programs, session answers and mode. */

import { expect } from "bun:test";
import { Schema } from "effect";
import { observe, open } from "../../tests/support/drive.ts";
import { test } from "../../tests/support/test.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { CallId, type ToolKind, ToolName } from "../agent-machine/names.ts";
import type { EffectRequest } from "../agent-machine/request.ts";
import { receivedJson } from "../agent-session/received.ts";
import { segmentsOf } from "../agent-host/command-parser.ts";
import { WordText } from "./command-segments.ts";
import type { Folders } from "./command-units.ts";
import { PermissionRule } from "./permission-rules.ts";
import { answerPicking, defaultPermissionSettings, explainedAt, explainedOf, OptionId, type PermissionMode, permissions, type PermissionQuestion, questionIn } from "./permissions.ts";

const kindOf = (tool: ToolName): ToolKind | undefined => (tool === "run_command" ? "execute" : tool === "write_file" ? "edit" : "execute");
const run = (command: string, id = "c1"): EffectRequest => ({ _tag: "RunTool", call: CallId.make(id), tool: ToolName.make("run_command"), input: receivedJson({ command, intent: "x" }) });

interface Judged {
  readonly step: "runs" | "asks" | "vetoed";
  readonly question: PermissionQuestion | undefined;
  readonly reason: string | undefined;
  readonly asks: ReturnType<typeof receivedJson> | undefined;
}

/** What the policy does with `command` in `mode`, given the session's `facts` and the rules. */
const judged = (
  command: string,
  options: { mode?: PermissionMode; facts?: ReadonlyArray<Fact>; canAsk?: boolean; allow?: ReadonlyArray<string>; deny?: ReadonlyArray<string>; tool?: string; folders?: Folders } = {},
): Judged => {
  const settings = { ...defaultPermissionSettings, allow: (options.allow ?? []).map((rule) => PermissionRule.make(rule)), deny: (options.deny ?? []).map((rule) => PermissionRule.make(rule)) };
  const policy = permissions(options.mode ?? "default", options.canAsk ?? true, kindOf, options.facts ?? [], { settings, segmentsOf, ...(options.folders === undefined ? {} : { folders: options.folders }) });
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

test("a program that reads outside the working folder is asked about, with only the call to allow, even when it is read-only or a rule allows the program; a Read rule matching the path lets it run", () => {
  expect(judged("cat ~/.aws/credentials").question).toMatchObject({
    needs: [{ program: "cat ~/.aws/credentials", why: "it reads outside the working folder: ~/.aws/credentials" }],
    grants: [],
  });
  expect(judged("cat src/a.ts | grep -n TODO").step).toBe("runs");
  expect(judged("cat ~/.aws/credentials", { allow: ["command(cat:*)"], folders: project }).question).toMatchObject({ needs: [{ kind: "readsOutside" }] });
  expect(judged("cat ~/.aws/credentials", { allow: ["Read(~/.aws/**)"], folders: project }).step).toBe("runs");
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

/** What the question about `command` shows besides its needs, worked out from its command. */
const explainedFor = (command: string) => {
  const question = judged(command).question;
  return question?._tag === "Command" ? { needs: question.needs, explained: explainedOf(question, segmentsOf, undefined) } : undefined;
};

test("a question stores why each program needs permission; what helps judge a program is worked out from the command when the question is shown", () => {
  const python = explainedFor("python3 -c 'print(1)' > out.txt");
  expect(python?.needs as unknown).toEqual([
    { program: "python3 -c 'print(1)'", kind: "opaque", why: "it runs code written in the command" },
    { program: "a redirect", kind: "writes", why: "it writes out.txt" },
  ]);
  expect((python === undefined ? undefined : explainedAt(python.explained, python.needs, 0)?.detail) as unknown).toEqual({ _tag: "Code", language: "python", code: "print(1)" });
  const sed = explainedFor("sed -i 's/a/b/' f.txt");
  expect(sed === undefined ? undefined : [0, 1].map((at) => explainedAt(sed.explained, sed.needs, at)?.detail?._tag)).toEqual(["Explained", undefined]);
  const rm = explainedFor("rm -rf build");
  expect(rm?.explained.notes as unknown).toEqual(["Allowing rm for the rest of the session lets later rm commands run without a question inside the working folder. Outside it, they are still asked about."]);
  expect(judged("sed -n 1p f", { facts: answered("sed -n 2p f", "allow-session") }).step).toBe("runs");
});

const project: Folders = { working: WordText.make("/home/dan/project"), home: WordText.make("/home/dan") };

test("after a program is allowed for the session, it runs inside the working folder, and is asked about, with only the call to allow, when it changes paths outside it", () => {
  const allowed = answered("rm -rf dist", "allow-session");
  expect(judged("rm -rf build", { facts: allowed, folders: project }).step).toBe("runs");
  const outside = judged("rm -rf ~/Code/other", { facts: allowed, folders: project });
  expect(outside.question).toMatchObject({ needs: [{ program: "rm -rf ~/Code/other", kind: "changesOutside", why: "it deletes outside the working folder: ~/Code/other" }], grants: [] });
  expect(judged('rm -rf "$DIR"', { facts: allowed, folders: project }).question).toMatchObject({ needs: [{ kind: "changesOutside", why: 'it deletes outside the working folder: "$DIR"' }] });
  expect(judged("git ls-files | xargs rm", { facts: allowed, folders: project }).question).toMatchObject({
    needs: [{ kind: "notAllowed" }, { program: "rm", kind: "changesOutside", why: "it deletes the paths it reads from its input, which may be outside the working folder" }],
  });
});

test("acceptEdits lets a command write files inside the working folder, not outside it; a file that is not a file (/dev/null) is not asked about", () => {
  expect(judged("echo x >> notes.txt", { mode: "acceptEdits", folders: project }).step).toBe("runs");
  expect(judged("echo x >> ~/.zshrc", { mode: "acceptEdits", folders: project }).question).toMatchObject({
    needs: [{ program: "a redirect", kind: "changesOutside", why: "it writes outside the working folder: ~/.zshrc" }],
  });
  expect(judged("git status > /dev/null 2>&1", { folders: project }).step).toBe("runs");
});

test("a command that changes paths outside the working folder is asked about even after cd and when a rule allows the program; an Edit rule matching the path, an allow rule for the whole tool, or bypassPermissions runs it", () => {
  expect(judged("cd ~/other && rm -rf build", { facts: answered("rm -rf dist", "allow-session"), folders: project }).question).toMatchObject({
    needs: [
      { program: "cd ~/other", kind: "readsOutside" },
      { program: "rm -rf build", kind: "changesOutside", why: "it deletes outside the working folder: build" },
    ],
  });
  expect(judged("rm -rf /tmp/build", { allow: ["command(rm:*)"], folders: project }).question).toMatchObject({ needs: [{ kind: "changesOutside" }] });
  expect(judged("rm -rf /tmp/build", { allow: ["command(rm:*)", "Edit(//tmp/**)"], folders: project }).step).toBe("runs");
  expect(judged("rm -rf /tmp/build", { allow: ["command(rm -rf build)"], folders: project }).question).toMatchObject({ needs: [{ kind: "notAllowed" }, { kind: "changesOutside" }] });
  expect(judged("rm -rf ~/Code/other", { mode: "bypassPermissions", folders: project }).step).toBe("runs");
  // An allow rule for the whole tool runs every command, as it does in every other case.
  expect(judged("rm -rf ~/Code/other", { allow: ["command"], folders: project }).step).toBe("runs");
});

test("when no one can answer, a change outside the working folder is vetoed with a hint that names bypassPermissions, not acceptEdits", () => {
  expect(judged("echo x >> ~/.zshrc", { mode: "acceptEdits", canAsk: false, folders: project }).reason).toBe(
    "run_command needs permission, and no one is there to answer: a redirect (it writes outside the working folder: ~/.zshrc). --permission-mode bypassPermissions lets it run.",
  );
});

test("a rule names a tool, exact words, a prefix (:*), or paths read (Read) or changed (Edit); a program rule naming a path, Write(…) and a path from a single / are refused, saying what to write", () => {
  const valid = Schema.is(PermissionRule);
  expect(["command", "run_command(git log)", "command(bun test:*)", "command(rm -rf build)", "Read(~/.ssh/**)", "Edit(//tmp/**)", "Read(./.env)", "Edit(src/**/*.ts)"].map(valid)).toEqual([true, true, true, true, true, true, true, true]);
  const refusal = (rule: string) => {
    const decoded = Schema.decodeResult(PermissionRule)(rule);
    return decoded._tag === "Failure" ? String(decoded.failure) : "accepted";
  };
  expect(refusal("command(rm:/tmp/*)")).toContain("A program rule names a program's words, not paths: use Read(<path>) or Edit(<path>), such as Edit(//tmp/**)");
  expect(refusal("Write(src/**)")).toContain("Write(<path>) does not name paths: use Edit(<path>)");
  expect(refusal("Read(/etc/**)")).toContain("A path rule may not start with a single /: write //<path>");
  expect(refusal("command(git log")).toContain("Expected <tool>, <tool>(<words>), <tool>(<words>:*), Read(<path>) or Edit(<path>)");
});

test("an Edit rule matching a path lifts only that path: the others are still named, and the program still needs allowing; an allowed edit allows reading too", () => {
  const rm = answered("rm -rf dist", "allow-session");
  expect(judged("rm -rf /tmp/a ~/x", { facts: rm, allow: ["Edit(//tmp/**)"], folders: project }).question).toMatchObject({
    needs: [{ kind: "changesOutside", why: "it deletes outside the working folder: ~/x" }],
  });
  expect(judged("rm -rf /tmp/a", { allow: ["Edit(//tmp/**)"], folders: project }).question).toMatchObject({ needs: [{ kind: "notAllowed" }], grants: [["rm"]] });
  expect(judged("cat /tmp/a/log.txt", { allow: ["Edit(//tmp/**)"], folders: project }).step).toBe("runs");
  expect(judged("echo done > notes.txt", { allow: ["Edit(notes.txt)"], folders: project }).step).toBe("runs");
});

test("a deny rule refuses a read or a change of a path it matches, inside the working folder or outside it, in every mode; changing a folder that holds a denied path is refused", () => {
  const deny = { deny: ["Read(./.env)", "Edit(~/.ssh/**)"], folders: project, mode: "bypassPermissions" as const };
  expect(judged("cat .env", deny).reason).toBe("cat .env is denied by the rule Read(./.env).");
  expect(judged("grep KEY config/.env", deny).reason).toBe("grep KEY config/.env is denied by the rule Read(./.env).");
  expect(judged("rm -rf ~", deny).reason).toBe("rm -rf ~ is denied by the rule Edit(~/.ssh/**).");
  expect(judged("echo x >> ~/.ssh/authorized_keys", deny).reason).toBe("a redirect is denied by the rule Edit(~/.ssh/**).");
  expect(judged("cat ~/.ssh/config", deny).step).toBe("runs");
  expect(judged("rm -rf build", deny).step).toBe("runs");
});

test("when deny rules name paths, a path they cannot see is asked about even in bypassPermissions: one not written out, or ones a program gets from its input", () => {
  const deny = { deny: ["Read(./.env)", "Edit(~/.ssh/**)"], folders: project, mode: "bypassPermissions" as const };
  expect(judged('cat "$F"', deny).question).toMatchObject({ needs: [{ kind: "unseen", why: 'deny rules cannot see which file it reads: "$F" is not written out' }] });
  expect(judged("git ls-files | xargs rm", deny).question).toMatchObject({ needs: [{ kind: "unseen", why: "deny rules cannot see which files it deletes: xargs gives them as it runs" }] });
  expect(judged('cat "$F"', { folders: project, mode: "bypassPermissions" }).step).toBe("runs");
});

test("an additional folder counts as inside the working folder: reading and changing in it need no path permission", () => {
  const withShared = { ...project, additional: [WordText.make("/home/dan/shared")] };
  expect(judged("cat ~/shared/notes.md", { folders: withShared }).step).toBe("runs");
  expect(judged("rm -rf ~/shared/build", { facts: answered("rm -rf dist", "allow-session"), folders: withShared }).step).toBe("runs");
  expect(judged("cat ~/other/notes.md", { folders: withShared }).question).toMatchObject({ needs: [{ kind: "readsOutside" }] });
});

test("a path deny rule sees past a cd, through find -exec and xargs, into a recursive search, and through a glob: it refuses what it can match and asks about what it cannot", () => {
  const deny = { deny: ["Read(secrets/**)", "Read(./.env)"], folders: project, mode: "bypassPermissions" as const };
  // A relative path after a cd is judged in the folder before the cd and in the one after it.
  expect(judged("cd secrets && cat key", deny).reason).toBe("cd secrets is denied by the rule Read(secrets/**); cat key is denied by the rule Read(secrets/**).");
  expect(judged("cd src && cat ../secrets/key", deny).reason).toBe("cat ../secrets/key is denied by the rule Read(secrets/**).");
  expect(judged("cd src && cat a.ts", deny).step).toBe("runs");
  expect(judged('cd "$D" && cat key', deny).question).toMatchObject({ needs: [{ kind: "unseen" }, { kind: "unseen", why: "deny rules cannot see which file it reads: a cd earlier in the command moves where key leads" }] });
  // The paths find -exec and xargs give are not seen.
  expect(judged("find . -name .env -exec cat {} \\;", deny).question).toMatchObject({ needs: [{ kind: "unseen", why: "deny rules cannot see which files it reads: find gives them as it runs" }] });
  expect(judged("git ls-files | xargs cat", deny).question).toMatchObject({ needs: [{ kind: "unseen", why: "deny rules cannot see which files it reads: xargs gives them as it runs" }] });
  // A recursive search reaches an anchored pattern inside the folder it searches; one that matches at any depth is not seen there.
  expect(judged("rg KEY .", deny).reason).toBe("rg KEY . is denied by the rule Read(secrets/**).");
  expect(judged("rg TODO src", deny).step).toBe("runs");
  // A glob could name a denied file.
  expect(judged("cat .en*", deny).question).toMatchObject({ needs: [{ kind: "unseen", why: "deny rules cannot see which files it reads: .en* is a pattern" }] });
});

test("a cd moves where later relative paths lead: after a cd outside the working folder, a change there is a change outside it", () => {
  const rm = answered("rm -rf dist", "allow-session");
  expect(judged("cd /tmp && rm -rf build", { facts: rm, allow: ["Read(//tmp/**)"], folders: project }).question).toMatchObject({ needs: [{ kind: "changesOutside", why: "it deletes outside the working folder: build" }] });
  // The paths find gives are under its starting points, which are find's own reads.
  expect(judged("find . -exec rm {} \\;", { facts: rm, allow: ["command(find:*)"], folders: project }).step).toBe("runs");
});
