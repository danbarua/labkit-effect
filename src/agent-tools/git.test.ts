/** Exercise the tools through their source against real repositories, without invoking git. */
import { expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "es-git";
import { Effect } from "effect";
import { test } from "../../tests/support/test.ts";
import { runTest } from "../../tests/support/run.ts";
import { CallId, ToolName } from "../agent-machine/names.ts";
import { asText, receivedJson } from "../agent-session/received.ts";
import { gitTools } from "./git.ts";

const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "git-tools-test-"));
  const repo = await git.initRepository(root, { initialHead: "main" });
  repo.config().setString("user.name", "Tool Test");
  repo.config().setString("user.email", "test@example.com");
  const call = async (name: string, input: unknown = {}, strictInput = false) => runTest(Effect.gen(function* () {
    const source = yield* gitTools(root, { strictInput }).source;
    const outcome = yield* source.run(ToolName.make(name), receivedJson(input as never), CallId.make("git-test"));
    if (outcome._tag === "Succeeded") return asText(outcome.output);
    return outcome.reason._tag === "InputRejected" ? `rejected: ${outcome.reason.problem}` : outcome.reason._tag === "Reported" ? `reported: ${asText(outcome.reason.error)}` : outcome.reason._tag;
  }));
  const write = (name: string, content: string) => writeFileSync(join(root, name), content);
  const read = (name: string) => readFileSync(join(root, name), "utf8");
  const seed = async () => {
    write("a.txt", "one\n");
    expect(await call("add", { paths: ["."] })).toBe("Index updated.");
    const id = await call("commit", { message: "initial" });
    expect(id).toMatch(/^[a-f0-9]{40}$/);
    return id;
  };
  return { root, repo, call, write, read, seed, dispose: () => rmSync(root, { recursive: true, force: true }) };
};

test("git catalog, schema rejection, ignored inputs, and missing repositories", async () => {
  const f = await fixture();
  try {
    const { catalog } = gitTools(f.root);
    expect(catalog.map((tool) => tool.name as string)).toEqual(["status", "branch", "diff", "log", "show", "remote", "revParse", "add", "commit", "push", "pull", "switch", "checkout", "restore", "reset", "stash", "tag"]);
    expect(catalog.filter((tool) => tool.replay === "safe").map((tool) => tool.name as string)).toEqual(["status", "diff", "log", "show", "revParse"]);
    expect(await f.call("status")).toBe("[]");
    expect(await f.call("log")).toBe("[]");
    expect(await f.call("add", { paths: [] })).toStartWith("rejected:");
    expect(await f.call("add", { paths: ["../outside"] })).toStartWith("rejected:");
    expect(await f.call("status", { extra: 1 })).toContain("ignored: extra");
    expect(await f.call("status", { extra: 1 }, true)).toStartWith("rejected:");
    expect(await f.call("missing")).toBe("NotFound");
    const result = await runTest(Effect.gen(function* () {
      const source = yield* gitTools(join(f.root, "missing")).source;
      return yield* source.run(ToolName.make("status"), receivedJson({}), CallId.make("missing"));
    }));
    expect(result._tag).toBe("Failed");
  } finally { f.dispose(); }
});

test("git add, commit, status, diff, log, show, and revParse preserve staged versus unstaged changes", async () => {
  const f = await fixture();
  try {
    const first = await f.seed();
    expect(await f.call("show")).toContain("one");
    expect(await f.call("show", { revision: "HEAD:a.txt" })).toBe("one\n");
    expect(await f.call("revParse", { revision: "HEAD" })).toBe(first);
    f.write("a.txt", "two\n");
    expect(await f.call("diff")).toContain("two");
    expect(await f.call("diff", { staged: true })).toBe("[]");
    await f.call("add", { paths: ["a.txt"] });
    f.write("a.txt", "three\n");
    expect(await f.call("diff", { staged: true })).toContain("two");
    expect(await f.call("diff")).toContain("three");
    const second = await f.call("commit", { message: "second" });
    expect(second).toMatch(/^[a-f0-9]{40}$/);
    expect(await f.call("show")).toContain("one");
    expect(JSON.parse(await f.call("log", { limit: 1 }))).toHaveLength(1);
    expect(JSON.parse(await f.call("log"))).toHaveLength(2);
    expect(await f.call("diff", { from: first, to: second, path: "a.txt" })).toContain("two");
    expect(await f.call("diff", { from: first, to: second, path: "missing" })).toBe("[]");
    expect(await f.call("commit", { message: "empty" })).toStartWith("rejected:");
    rmSync(join(f.root, "a.txt"));
    await f.call("add", { paths: ["."] });
    expect(await f.call("diff", { staged: true })).toContain("Deleted");
    expect(await f.call("status")).toContain('"indexDeleted": true');
  } finally { f.dispose(); }
});

test("git branch, switch, checkout and tags handle refs and refuse conflicting checkout", async () => {
  const f = await fixture();
  try {
    const first = await f.seed();
    expect(await f.call("branch", { action: "create", name: "feature" })).toBe("Created feature.");
    expect(await f.call("switch", { target: "feature" })).toContain('"branch": "feature"');
    f.write("a.txt", "feature\n");
    await f.call("add", { paths: ["."] });
    await f.call("commit", { message: "feature" });
    f.write("a.txt", "dirty\n");
    expect(await f.call("switch", { target: "main" })).toStartWith("reported:");
    expect(f.read("a.txt")).toBe("dirty\n");
    expect(await f.call("switch", { target: "main", force: true })).toContain('"branch": "main"');
    expect(await f.call("branch", { action: "delete", name: "feature" })).toStartWith("rejected:");
    expect(await f.call("branch", { action: "rename", name: "feature", newName: "renamed" })).toContain("Renamed");
    expect(await f.call("branch", { action: "list" })).toContain("renamed");
    expect(await f.call("branch", { action: "delete", name: "renamed", force: true })).toContain("Deleted");
    expect(await f.call("checkout", { target: first, detach: true })).toContain('"branch": null');
    expect(await f.call("switch", { target: "new", create: true })).toContain('"branch": "new"');
    expect(await f.call("tag", { action: "create", name: "v1" })).toBe(first);
    expect(await f.call("tag", { action: "create", name: "v2", message: "release" })).toMatch(/^[a-f0-9]{40}$/);
    expect(JSON.parse(await f.call("tag", { action: "list" }))).toEqual(["v1", "v2"]);
    expect(await f.call("tag", { action: "delete", name: "v1" })).toContain("Deleted");
  } finally { f.dispose(); }
});

test("git restore and reset change only the requested index and worktree destinations", async () => {
  const f = await fixture();
  try {
    const first = await f.seed();
    f.write("a.txt", "staged\n");
    await f.call("add", { paths: ["."] });
    f.write("a.txt", "unstaged\n");
    expect(await f.call("restore", { path: "a.txt" })).toContain("Restored");
    expect(f.read("a.txt")).toBe("staged\n");
    expect(await f.call("diff", { staged: true })).toContain("staged");
    expect(await f.call("restore", { path: "a.txt", staged: true })).toContain("Restored");
    expect(f.read("a.txt")).toBe("staged\n");
    expect(await f.call("diff", { staged: true })).toBe("[]");
    await f.call("restore", { path: "a.txt", source: "HEAD" });
    expect(f.read("a.txt")).toBe("one\n");
    f.write("a.txt", "second\n");
    await f.call("add", { paths: ["."] });
    const second = await f.call("commit", { message: "second" });
    expect(await f.call("reset", { revision: first, mode: "soft" })).toContain("Reset soft");
    expect(await f.call("revParse", { revision: "HEAD" })).toBe(first);
    expect(await f.call("diff", { staged: true })).toContain("second");
    expect(await f.call("reset")).toContain("Reset mixed");
    expect(f.read("a.txt")).toBe("second\n");
    expect(await f.call("diff", { staged: true })).toBe("[]");
    expect(await f.call("reset", { revision: second, mode: "hard" })).toContain("Reset hard");
    expect(await f.call("status")).toBe("[]");
    expect(f.read("a.txt")).toBe("second\n");
  } finally { f.dispose(); }
});

test("git stash saves, applies, pops and drops changes", async () => {
  const f = await fixture();
  try {
    await f.seed();
    f.write("a.txt", "saved\n");
    expect(await f.call("stash", { action: "save", message: "work" })).toMatch(/^[a-f0-9]{40}$/);
    expect(f.read("a.txt")).toBe("one\n");
    expect(await f.call("stash", { action: "list" })).toContain("work");
    expect(await f.call("stash", { action: "apply" })).toContain("completed");
    expect(f.read("a.txt")).toBe("saved\n");
    await f.call("restore", { path: "a.txt" });
    expect(await f.call("stash", { action: "pop" })).toContain("completed");
    expect(await f.call("stash", { action: "list" })).toBe("[]");
    await f.call("stash", { action: "save" });
    expect(await f.call("stash", { action: "drop" })).toContain("completed");
    expect(await f.call("stash", { action: "list" })).toBe("[]");
  } finally { f.dispose(); }
});

test("git remotes, push and fast-forward pull work with a local bare remote and reject divergence", async () => {
  const f = await fixture();
  const peer = await fixture();
  const remotePath = mkdtempSync(join(tmpdir(), "git-tools-remote-"));
  try {
    await git.initRepository(remotePath, { bare: true, initialHead: "main" });
    const first = await f.seed();
    expect(await f.call("remote", { action: "add", name: "origin", url: remotePath })).toContain("updated");
    expect(await f.call("remote", { action: "list" })).toContain(remotePath);
    expect(await f.call("remote", { action: "setUrl", name: "origin", url: remotePath })).toContain("updated");
    expect(await f.call("push")).toBe("Push completed.");
    await peer.repo.createRemote("origin", remotePath).fetch(["refs/heads/main"]);
    const target = peer.repo.getCommit(peer.repo.revparseSingle("FETCH_HEAD"));
    peer.repo.createBranch("main", target);
    peer.repo.checkoutHead();
    peer.write("a.txt", "remote\n");
    await peer.call("add", { paths: ["."] });
    const second = await peer.call("commit", { message: "remote" });
    expect(await peer.call("push")).toBe("Push completed.");
    expect(await f.call("pull")).toBe(`Fast-forwarded to ${second}.`);
    expect(f.read("a.txt")).toBe("remote\n");
    expect(await f.call("pull")).toBe("Already up to date.");
    await f.call("reset", { revision: first, mode: "hard" });
    f.write("a.txt", "local\n");
    await f.call("add", { paths: ["."] });
    const local = await f.call("commit", { message: "local" });
    expect(await f.call("pull")).toStartWith("rejected:");
    expect(await f.call("revParse", { revision: "HEAD" })).toBe(local);
    expect(await f.call("push")).toStartWith("reported:");
  } finally { f.dispose(); peer.dispose(); rmSync(remotePath, { recursive: true, force: true }); }
});


test("git diff reports binary and symlink changes, and staged restore preserves unrelated staged files", async () => {
  const f = await fixture();
  try {
    await f.seed();
    f.write("a.txt", "changed\n");
    f.write("b.txt", "new\n");
    await f.call("add", { paths: ["."] });
    expect(await f.call("restore", { path: "a.txt", staged: true })).toContain("Restored");
    expect(JSON.parse(await f.call("diff", { staged: true }))).toEqual([
      { status: "Added", oldPath: "b.txt", newPath: "b.txt", before: null, after: "new\n" },
    ]);
    expect(f.read("a.txt")).toBe("changed\n");
    expect(await f.call("reset")).toContain("Reset mixed");
    expect(f.read("b.txt")).toBe("new\n");
    expect(await f.call("diff", { staged: true })).toBe("[]");
    writeFileSync(join(f.root, "a.txt"), Buffer.from([0, 1, 2]));
    expect(await f.call("diff")).toContain('"binary": true');
    symlinkSync("a.txt", join(f.root, "link"));
    await f.call("add", { paths: ["link"] });
    await f.call("commit", { message: "link" });
    rmSync(join(f.root, "link"));
    symlinkSync("missing-target", join(f.root, "link"));
    expect(JSON.parse(await f.call("diff", { path: "link" }))).toEqual([
      { status: "Modified", oldPath: "link", newPath: "link", before: "a.txt", after: "missing-target" },
    ]);
  } finally { f.dispose(); }
});
