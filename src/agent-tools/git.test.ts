/** Exercise the tools through their source against real repositories, without invoking git. */
import {expect} from "bun:test";
import {mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import * as git from "es-git";
import {Effect} from "effect";
import {test} from "../../tests/support/test.ts";
import {runTest} from "../../tests/support/run.ts";
import {CallId, ToolName} from "../agent-machine/names.ts";
import {asText, receivedJson} from "../agent-session/received.ts";
import {undescribedInputs} from "../../tests/support/tool-input.ts";
import {described} from "./described.ts";
import {gitTools, gitToolsWith} from "./git.ts";
import {inWorkspace} from "./in-workspace.ts";
import {anyTool} from "./tool.ts";

const fixture = async () => {
    const root = mkdtempSync(join(tmpdir(), "git-tools-test-"));
    const repo = await git.initRepository(root, {initialHead: "main"});
    repo.config().setString("user.name", "Tool Test");
    repo.config().setString("user.email", "test@example.com");
    const call = async (name: string, input: object = {}, strictInput = false) => runTest(Effect.gen(function* () {
        const source = yield* gitTools(root, {strictInput}).source;
        const outcome = yield* source.run(ToolName.make(name), receivedJson({intent: "A test call.", ...input} as never), CallId.make("git-test"));
        if (outcome._tag === "Succeeded") return asText(outcome.output);
        return outcome.reason._tag === "InputRejected" ? `rejected: ${outcome.reason.problem}` : outcome.reason._tag === "Reported" ? `reported: ${asText(outcome.reason.error)}` : outcome.reason._tag;
    }));
    const write = (name: string, content: string) => writeFileSync(join(root, name), content);
    const read = (name: string) => readFileSync(join(root, name), "utf8");
    const seed = async () => {
        write("a.txt", "one\n");
        expect(await call("git_add", {paths: ["."]})).toBe("Index updated.");
        const id = await call("git_commit", {message: "initial"});
        expect(id).toMatch(/^[a-f0-9]{40}$/);
        return id;
    };
    return {root, repo, call, write, read, seed, dispose: () => rmSync(root, {recursive: true, force: true})};
};

test("git catalog, schema rejection, ignored inputs, and missing repositories", async () => {
    const f = await fixture();
    try {
        const {catalog} = gitTools(f.root);
        expect(catalog.map((tool) => tool.name as string)).toEqual(["git_status", "git_branch", "git_diff", "git_log", "git_show", "git_remote", "git_rev_parse", "git_add", "git_commit", "git_push", "git_pull", "git_switch", "git_checkout", "git_restore", "git_reset", "git_stash", "git_tag"]);
        expect(catalog.filter((tool) => tool.replay === "safe").map((tool) => tool.name as string)).toEqual(["git_status", "git_diff", "git_log", "git_show", "git_rev_parse"]);
        expect(await f.call("git_status")).toBe("[]");
        expect(await f.call("git_log")).toBe("[]");
        expect(await f.call("git_add", {paths: []})).toStartWith("rejected:");
        expect(await f.call("git_add", {paths: ["../outside"]})).toStartWith("rejected:");
        expect(await f.call("git_status", {extra: 1})).toContain("ignored: extra");
        expect(await f.call("git_status", {extra: 1}, true)).toStartWith("rejected:");
        expect(await f.call("missing")).toBe("NotFound");
        const result = await runTest(Effect.gen(function* () {
            const source = yield* gitTools(join(f.root, "missing")).source;
            return yield* source.run(ToolName.make("git_status"), receivedJson({intent: "A test call."}), CallId.make("missing"));
        }));
        expect(result).toMatchObject({_tag: "Failed", reason: {_tag: "Reported"}});
    } finally {
        f.dispose();
    }
});

test("git add, commit, status, diff, log, show, and revParse preserve staged versus unstaged changes", async () => {
    const f = await fixture();
    try {
        const first = await f.seed();
        expect(await f.call("git_show")).toContain("one");
        expect(await f.call("git_show", {revision: "HEAD:a.txt"})).toBe("one\n");
        expect(await f.call("git_rev_parse", {revision: "HEAD"})).toBe(first);
        f.write("a.txt", "two\n");
        expect(await f.call("git_diff")).toContain("two");
        expect(await f.call("git_diff", {staged: true})).toBe("[]");
        await f.call("git_add", {paths: ["a.txt"]});
        f.write("a.txt", "three\n");
        expect(await f.call("git_diff", {staged: true})).toContain("two");
        expect(await f.call("git_diff")).toContain("three");
        const second = await f.call("git_commit", {message: "second"});
        expect(second).toMatch(/^[a-f0-9]{40}$/);
        expect(await f.call("git_show")).toContain("one");
        expect(JSON.parse(await f.call("git_log", {limit: 1}))).toHaveLength(1);
        expect(JSON.parse(await f.call("git_log"))).toHaveLength(2);
        expect(await f.call("git_diff", {from: first, to: second, path: "a.txt"})).toContain("two");
        expect(await f.call("git_diff", {from: first, to: second, path: "missing"})).toBe("[]");
        expect(await f.call("git_commit", {message: "empty"})).toStartWith("rejected:");
        rmSync(join(f.root, "a.txt"));
        await f.call("git_add", {paths: ["."]});
        expect(await f.call("git_diff", {staged: true})).toContain("Deleted");
        expect(await f.call("git_status")).toContain('"indexDeleted": true');
    } finally {
        f.dispose();
    }
});

test("git branch, switch, checkout and tags handle refs and refuse conflicting checkout; the branch list marks the current branch", async () => {
    const f = await fixture();
    try {
        const first = await f.seed();
        expect(await f.call("git_branch", {action: "create", name: "feature"})).toBe("Created feature.");
        expect(await f.call("git_switch", {target: "feature"})).toContain('"branch": "feature"');
        f.write("a.txt", "feature\n");
        await f.call("git_add", {paths: ["."]});
        await f.call("git_commit", {message: "feature"});
        f.write("a.txt", "dirty\n");
        expect(await f.call("git_switch", {target: "main"})).toStartWith("reported:");
        expect(f.read("a.txt")).toBe("dirty\n");
        expect(await f.call("git_switch", {target: "main", force: true})).toContain('"branch": "main"');
        expect(await f.call("git_branch", {action: "delete", name: "feature"})).toStartWith("rejected:");
        expect(await f.call("git_branch", {action: "rename", name: "feature", new_name: "renamed"})).toContain("Renamed");
        expect(await f.call("git_branch", {action: "list"})).toContain("renamed");
        expect(JSON.parse(await f.call("git_branch", {action: "list", type: "Local"}))).toEqual([{type: "Local", name: "main", current: true}, {type: "Local", name: "renamed"}]);
        expect(await f.call("git_branch", {action: "delete", name: "renamed", force: true})).toContain("Deleted");
        expect(await f.call("git_checkout", {target: first, detach: true})).toContain('"branch": null');
        expect(await f.call("git_switch", {target: "new", create: true})).toContain('"branch": "new"');
        expect(await f.call("git_tag", {action: "create", name: "v1"})).toBe(first);
        expect(await f.call("git_tag", {action: "create", name: "v2", message: "release"})).toMatch(/^[a-f0-9]{40}$/);
        expect(JSON.parse(await f.call("git_tag", {action: "list"}))).toEqual(["v1", "v2"]);
        expect(await f.call("git_tag", {action: "delete", name: "v1"})).toContain("Deleted");
    } finally {
        f.dispose();
    }
});

test("git restore and reset change only the requested index and worktree destinations", async () => {
    const f = await fixture();
    try {
        const first = await f.seed();
        f.write("a.txt", "staged\n");
        await f.call("git_add", {paths: ["."]});
        f.write("a.txt", "unstaged\n");
        expect(await f.call("git_restore", {path: "a.txt"})).toContain("Restored");
        expect(f.read("a.txt")).toBe("staged\n");
        expect(await f.call("git_diff", {staged: true})).toContain("staged");
        expect(await f.call("git_restore", {path: "a.txt", staged: true})).toContain("Restored");
        expect(f.read("a.txt")).toBe("staged\n");
        expect(await f.call("git_diff", {staged: true})).toBe("[]");
        await f.call("git_restore", {path: "a.txt", source: "HEAD"});
        expect(f.read("a.txt")).toBe("one\n");
        f.write("a.txt", "second\n");
        await f.call("git_add", {paths: ["."]});
        const second = await f.call("git_commit", {message: "second"});
        expect(await f.call("git_reset", {revision: first, mode: "soft"})).toContain("Reset soft");
        expect(await f.call("git_rev_parse", {revision: "HEAD"})).toBe(first);
        expect(await f.call("git_diff", {staged: true})).toContain("second");
        expect(await f.call("git_reset")).toContain("Reset mixed");
        expect(f.read("a.txt")).toBe("second\n");
        expect(await f.call("git_diff", {staged: true})).toBe("[]");
        expect(await f.call("git_reset", {revision: second, mode: "hard"})).toContain("Reset hard");
        expect(await f.call("git_status")).toBe("[]");
        expect(f.read("a.txt")).toBe("second\n");
    } finally {
        f.dispose();
    }
});

test("git stash saves, applies, pops and drops changes", async () => {
    const f = await fixture();
    try {
        await f.seed();
        f.write("a.txt", "saved\n");
        expect(await f.call("git_stash", {action: "save", message: "work"})).toMatch(/^[a-f0-9]{40}$/);
        expect(f.read("a.txt")).toBe("one\n");
        expect(await f.call("git_stash", {action: "list"})).toContain("work");
        expect(await f.call("git_stash", {action: "apply"})).toContain("completed");
        expect(f.read("a.txt")).toBe("saved\n");
        await f.call("git_restore", {path: "a.txt"});
        expect(await f.call("git_stash", {action: "pop"})).toContain("completed");
        expect(await f.call("git_stash", {action: "list"})).toBe("[]");
        await f.call("git_stash", {action: "save"});
        expect(await f.call("git_stash", {action: "drop"})).toContain("completed");
        expect(await f.call("git_stash", {action: "list"})).toBe("[]");
    } finally {
        f.dispose();
    }
});

test("git remotes, push and fast-forward pull work with a local bare remote and reject divergence", async () => {
    const f = await fixture();
    const peer = await fixture();
    const remotePath = mkdtempSync(join(tmpdir(), "git-tools-remote-"));
    try {
        await git.initRepository(remotePath, {bare: true, initialHead: "main"});
        const first = await f.seed();
        expect(await f.call("git_remote", {action: "add", name: "origin", url: remotePath})).toContain("updated");
        expect(await f.call("git_remote", {action: "list"})).toContain(remotePath);
        expect(await f.call("git_remote", {action: "set_url", name: "origin", url: remotePath})).toContain("updated");
        expect(await f.call("git_push")).toBe("Push completed.");
        await peer.repo.createRemote("origin", remotePath).fetch(["refs/heads/main"]);
        const target = peer.repo.getCommit(peer.repo.revparseSingle("FETCH_HEAD"));
        peer.repo.createBranch("main", target);
        peer.repo.checkoutHead();
        peer.write("a.txt", "remote\n");
        await peer.call("git_add", {paths: ["."]});
        const second = await peer.call("git_commit", {message: "remote"});
        expect(await peer.call("git_push")).toBe("Push completed.");
        expect(await f.call("git_pull")).toBe(`Fast-forwarded to ${second}.`);
        expect(f.read("a.txt")).toBe("remote\n");
        expect(await f.call("git_pull")).toBe("Already up to date.");
        await f.call("git_reset", {revision: first, mode: "hard"});
        f.write("a.txt", "local\n");
        await f.call("git_add", {paths: ["."]});
        const local = await f.call("git_commit", {message: "local"});
        expect(await f.call("git_pull")).toStartWith("rejected:");
        expect(await f.call("git_rev_parse", {revision: "HEAD"})).toBe(local);
        expect(await f.call("git_push")).toStartWith("reported:");
    } finally {
        f.dispose();
        peer.dispose();
        rmSync(remotePath, {recursive: true, force: true});
    }
});


test("git diff reports binary and symlink changes, and staged restore preserves unrelated staged files", async () => {
    const f = await fixture();
    try {
        await f.seed();
        f.write("a.txt", "changed\n");
        f.write("b.txt", "new\n");
        await f.call("git_add", {paths: ["."]});
        expect(await f.call("git_restore", {path: "a.txt", staged: true})).toContain("Restored");
        expect(JSON.parse(await f.call("git_diff", {staged: true}))).toEqual([
            {status: "Added", oldPath: "b.txt", newPath: "b.txt", before: null, after: "new\n"},
        ]);
        expect(f.read("a.txt")).toBe("changed\n");
        expect(await f.call("git_reset")).toContain("Reset mixed");
        expect(f.read("b.txt")).toBe("new\n");
        expect(await f.call("git_diff", {staged: true})).toBe("[]");
        writeFileSync(join(f.root, "a.txt"), Buffer.from([0, 1, 2]));
        expect(await f.call("git_diff")).toContain('"binary": true');
        symlinkSync("a.txt", join(f.root, "link"));
        await f.call("git_add", {paths: ["link"]});
        await f.call("git_commit", {message: "link"});
        rmSync(join(f.root, "link"));
        symlinkSync("missing-target", join(f.root, "link"));
        expect(JSON.parse(await f.call("git_diff", {path: "link"}))).toEqual([
            {status: "Modified", oldPath: "link", newPath: "link", before: "a.txt", after: "missing-target"},
        ]);
    } finally {
        f.dispose();
    }
});

test("bound to a repository, the git tools are not offered repository, every input has a description, and no description or input schema names the repository's folder", () => {
    const {catalog} = gitTools("/work/project");
    expect(catalog.filter((tool) => JSON.stringify(tool.input).includes('"repository"')).map((tool) => tool.name as string)).toEqual([]);
    expect(catalog.flatMap((tool) => undescribedInputs(tool.input).map((input) => `${tool.name}: ${input}`))).toEqual([]);
    expect(catalog.filter((tool) => JSON.stringify([tool.description, tool.input]).includes("/work/project")).map((tool) => tool.name as string)).toEqual([]);
    expect(catalog.every((tool) => JSON.stringify(tool.input).includes('"intent"'))).toBe(true);
});

test("an unbound git tool is offered repository as a folder path, which inWorkspace describes as relative to the working folder", () => {
    const [status] = gitToolsWith((tool) => anyTool(described(inWorkspace("/work")(tool))));
    expect(status?.spec.input).toMatchObject({
        properties: {repository: {description: 'The folder\'s path: relative to the working folder, or absolute inside it. "." is the working folder.'}},
        required: ["repository", "intent"],
    });
});

test("a git tool with an action refuses a call without an input that the action needs, and runs a call with an input the action does not use, naming it in the result", async () => {
    const f = await fixture();
    try {
        await f.seed();
        expect(await f.call("git_branch", {action: "create"})).toBe("rejected: The create action needs name.");
        expect(await f.call("git_branch", {action: "rename", name: "main"})).toBe("rejected: The rename action needs new_name.");
        expect(await f.call("git_tag", {action: "list", name: "v1"})).toBe("[]\n[Not used by list, so ignored: name.]");
        expect(await f.call("git_remote", {action: "list"})).toBe("[]");
    } finally {
        f.dispose();
    }
});

test("the system line says that the working folder is a git worktree for a linked worktree, and a git repository for the main checkout", async () => {
    const f = await fixture();
    try {
        await f.seed();
        const linked = join(f.root, "..", `${basename(f.root)}-worktree`);
        f.repo.worktree("linked", linked);
        try {
            expect(await Effect.runPromise(gitTools(linked).system)).toBe("The working folder is the root of a git worktree, which the git tools work in.");
            expect(await Effect.runPromise(gitTools(f.root).system)).toBe("The working folder is the root of a git repository, which the git tools work in.");
        } finally {
            rmSync(linked, {recursive: true, force: true});
        }
    } finally {
        f.dispose();
    }
});
