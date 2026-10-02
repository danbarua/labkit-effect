/** The log a launched ACP agent keeps. */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Cause, Console, Effect, Layer } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test, testFolder } from "../../tests/support/test.ts";
import { type LauncherLogOptions, LauncherLogs, launcherLogOptionsFrom, recordLimit } from "./launcher-logs.ts";

/** A pid no process has: above the highest a system gives. */
const stoppedPid = 99_999_999;

const fileOf = (dir: string, launchId = "test") => join(dir, `acp-${process.pid}-${launchId}.jsonl`);

/** A line as the file holds it; a cut one has `record` and `omittedBytes` in place of the rest. */
interface Line {
  readonly time: string;
  readonly level: string;
  readonly annotations?: Record<string, unknown>;
  readonly message?: unknown;
  readonly cause?: string;
  readonly record?: string;
  readonly omittedBytes?: number;
}

const linesOf = async (file: string): Promise<Array<Line>> =>
  (await Bun.file(file).text())
    .split("\n")
    .filter((line) => line !== "")
    .map((line): Line => JSON.parse(line));

/** Runs `program` with the launcher's log in `options.dir`, and gives what went to stderr, a line per call. */
const launched = async (options: Partial<LauncherLogOptions> & { readonly dir: string }, program: Effect.Effect<unknown>): Promise<Array<string>> => {
  const stderr: Array<string> = [];
  const console = { ...globalThis.console, error: (...args: ReadonlyArray<unknown>) => void stderr.push(args.map(String).join(" ")) };
  const layer = LauncherLogs({ level: "Debug", maxBytes: 1024 * 1024, backups: 2, launchId: "test", keep: 20, secrets: [], ...options });
  await runTest(program.pipe(Effect.provide(layer.pipe(Layer.provide(BunServices.layer))), Effect.provideService(Console.Console, console)));
  return stderr;
};

test("H12: a record is a line of JSON in acp-<pid>-<launch id>.jsonl: its time, level, annotations, message and an error's cause in full; the path is said on stderr once", async () => {
  const dir = `${testFolder()}/not/yet/made`;
  const stderr = await launched(
    { dir },
    Effect.gen(function* () {
      yield* Effect.logInfo("session.opened", { model: "m" }).pipe(Effect.annotateLogs({ sessionId: "s1", turn: 2 }));
      yield* Effect.logError("turn.failed", Cause.fail(new Error("refused", { cause: new Error("socket closed") }))).pipe(Effect.annotateLogs({ callId: "c9" }));
    }),
  );
  expect(stderr).toEqual([`ACP log: ${fileOf(dir)}`]);
  const [opened, failed] = await linesOf(fileOf(dir));
  expect(Object.keys(opened!)).toEqual(["time", "level", "annotations", "message"]);
  expect(new Date(String(opened!.time)).toISOString()).toBe(String(opened!.time));
  expect(opened).toMatchObject({ level: "info", annotations: { sessionId: "s1", turn: 2 }, message: ["session.opened", { model: "m" }] });
  expect(failed).toMatchObject({ level: "error", annotations: { callId: "c9" }, message: "turn.failed" });
  expect(failed!.cause).toContain("Error: refused");
  expect(failed!.cause).toContain("[cause]: Error: socket closed");
  expect(failed!.cause).toContain("launcher-logs.test.ts");
});

test.each([
  ["Trace", ["trace", "debug", "info", "warning", "error"]],
  ["Warn", ["warning", "error"]],
] as const)("H12: at level %p, the records below it are not written; a warning is written as `warning`", async (level, written) => {
  const dir = `${testFolder()}/logs`;
  const all = [Effect.logTrace("t"), Effect.logDebug("d"), Effect.logInfo("i"), Effect.logWarning("w"), Effect.logError("e")];
  await launched({ dir, level }, Effect.all(all));
  expect((await linesOf(fileOf(dir))).map((line) => line.level)).toEqual([...written]);
});

test("H12: the environment gives the folder, level, size and backups; unset, the defaults; the secrets are the values of the variables named for them", () => {
  expect(launcherLogOptionsFrom({})).toMatchObject({ dir: join(homedir(), ".labkit", "logs"), level: "Debug", maxBytes: 10 * 1024 * 1024, backups: 4, keep: 20, secrets: [] });
  const options = launcherLogOptionsFrom({
    LABKIT_ACP_LOG_DIR: "/tmp/acp-logs",
    LABKIT_ACP_LOG_LEVEL: "WARNING",
    LABKIT_ACP_LOG_MAX_BYTES: "2048",
    LABKIT_ACP_LOG_BACKUPS: "0",
    OPENAI_API_KEY: "sk-1",
    GITHUB_TOKEN: "gh-2",
    DB_PASSWORD: "",
    HOME_DIR: "/home/x",
  });
  expect(options).toMatchObject({ dir: "/tmp/acp-logs", level: "Warn", maxBytes: 2048, backups: 0, secrets: ["sk-1", "gh-2"] });
  expect(options.launchId).not.toBe(launcherLogOptionsFrom({}).launchId);
});

test.each(["", "ten", "-5", "1.5", "0x", "1e400"])("H12: a size or backup count that does not read (%p) falls back to the default", (value) => {
  expect(launcherLogOptionsFrom({ LABKIT_ACP_LOG_MAX_BYTES: value, LABKIT_ACP_LOG_BACKUPS: value })).toMatchObject({ maxBytes: 10 * 1024 * 1024, backups: 4 });
});

test.each(["verbose", "constructor", "Warn"])("H12: a level that is not one of trace, debug, info, warning, error, fatal (%p) falls back to debug", (value) => {
  expect(launcherLogOptionsFrom({ LABKIT_ACP_LOG_LEVEL: value }).level).toBe("Debug");
});

test("H13: a record that would take the file past maxBytes rotates it first: .jsonl to .1 and on, no more than `backups` kept", async () => {
  const dir = `${testFolder()}/logs`;
  const maxBytes = 1000;
  await launched(
    { dir, maxBytes, backups: 2 },
    Effect.forEach(Array.from({ length: 20 }, (_, index) => index), (index) => Effect.logInfo(`entry ${index} ${"x".repeat(200)}`), { discard: true }),
  );
  const file = fileOf(dir);
  expect(readdirSync(dir).sort()).toEqual([`${file}`, `${file}.1`, `${file}.2`].map((path) => path.slice(dir.length + 1)));
  const indices: Array<number> = [];
  for (const path of [`${file}.2`, `${file}.1`, file]) {
    expect(Bun.file(path).size).toBeLessThanOrEqual(maxBytes);
    for (const { message } of await linesOf(path)) indices.push(Number(/entry (\d+)/.exec(String(message))![1]));
  }
  expect(indices.at(-1)).toBe(19);
  expect(indices[0]).toBeGreaterThan(0);
  expect(indices).toEqual(Array.from({ length: indices.length }, (_, offset) => indices[0]! + offset));
});

test("H13: a record past 256 KiB is cut to fit, saying how many bytes were left out; it is not dropped", async () => {
  const dir = `${testFolder()}/logs`;
  const big = `"é😀\\x`.repeat(60 * 1024);
  await launched({ dir }, Effect.all([Effect.logInfo(big), Effect.logInfo("after")]));
  const text = await Bun.file(fileOf(dir)).text();
  const [cutLine] = text.split("\n");
  expect(Buffer.byteLength(cutLine!)).toBeLessThanOrEqual(recordLimit);
  expect(Buffer.byteLength(cutLine!)).toBeGreaterThan(recordLimit - 16);
  const [cut, after] = await linesOf(fileOf(dir));
  expect(cut).toMatchObject({ level: "info" });
  const record = String(cut!.record);
  expect(record.startsWith(`{"time":"${String(cut!.time)}","level":"info","annotations":`)).toBe(true);
  // The record's whole line: its text kept and its bytes left out. The message alone is its JSON, escaped.
  const whole = Buffer.byteLength(record) + Number(cut!.omittedBytes);
  expect(whole).toBeGreaterThan(Buffer.byteLength(JSON.stringify(big)));
  expect(whole).toBeLessThan(Buffer.byteLength(JSON.stringify(big)) + 1024);
  expect(after).toMatchObject({ message: "after" });
});

test("H13: at start the newest `keep` stopped launches' files stay, their backups with them; a running launch's stay whatever their age", async () => {
  const dir = `${testFolder()}/logs`;
  mkdirSync(dir);
  const start = Date.now() / 1000 - 10_000;
  const made = (name: string, age: number) => {
    writeFileSync(join(dir, name), "{}\n");
    utimesSync(join(dir, name), start + age, start + age);
  };
  for (const index of [0, 1, 2, 3, 4]) made(`acp-${stoppedPid}-old${index}.jsonl`, index * 100);
  made(`acp-${stoppedPid}-old4.jsonl.1`, 350);
  made(`acp-${stoppedPid}-old1.jsonl.1`, 50);
  made(`acp-${process.pid}-running.jsonl`, -1000);
  made("notes.txt", -1000);
  await launched({ dir, keep: 2 }, Effect.logInfo("started"));
  expect(readdirSync(dir).sort()).toEqual(
    [
      `acp-${process.pid}-running.jsonl`,
      `acp-${process.pid}-test.jsonl`,
      `acp-${stoppedPid}-old3.jsonl`,
      `acp-${stoppedPid}-old4.jsonl`,
      `acp-${stoppedPid}-old4.jsonl.1`,
      "notes.txt",
    ].sort(),
  );
});

test("H14: an environment secret is redacted in the message, an annotation and a cause, and a credential field whatever its value; the error's text stays", async () => {
  const dir = `${testFolder()}/logs`;
  await launched(
    { dir, secrets: ["tok-4", "sk-secret-123"] },
    Effect.logWarning(
      "calling with sk-secret-123",
      { headers: { authorization: "Bearer plain-credential", inputTokens: 5 } },
      Cause.fail(new Error("refused tok-456", { cause: new Error("inner sk-secret-123") })),
    ).pipe(Effect.annotateLogs({ requestId: "r-tok-4" })),
  );
  const text = await Bun.file(fileOf(dir)).text();
  for (const secret of ["sk-secret-123", "tok-4", "plain-credential"]) expect(text).not.toContain(secret);
  const [record] = await linesOf(fileOf(dir));
  expect(record).toMatchObject({
    annotations: { requestId: "r-[redacted]" },
    message: ["calling with [redacted]", { headers: { authorization: "[redacted]", inputTokens: 5 } }],
  });
  expect(record!.cause).toContain("Error: refused [redacted]56");
  expect(record!.cause).toContain("[cause]: Error: inner [redacted]");
});

test("H14: a folder that cannot be made is said once on stderr, and every record goes to stderr; nothing throws", async () => {
  writeFileSync(`${testFolder()}/blocker`, "");
  const dir = `${testFolder()}/blocker/logs`;
  const stderr = await launched({ dir }, Effect.all([Effect.logInfo("first"), Effect.logInfo("second")]));
  expect(stderr[0]).toBe(`ACP log: ${fileOf(dir)}`);
  expect(stderr.filter((line) => line.includes("cannot write"))).toHaveLength(1);
  expect(stderr[1]).toContain(`ACP log: cannot write ${fileOf(dir)}`);
  expect(stderr.slice(2).map((line) => JSON.parse(line).message)).toEqual(["first", "second"]);
});

test("H14: a file that stops being writable is said once on stderr, and the records after it go to stderr", async () => {
  const dir = `${testFolder()}/logs`;
  mkdirSync(dir);
  const stderr = await launched(
    { dir },
    Effect.gen(function* () {
      yield* Effect.logInfo("to the file");
      yield* Effect.sync(() => rmSync(dir, { recursive: true }));
      yield* Effect.logInfo("to stderr");
      yield* Effect.logInfo("to stderr too");
    }),
  );
  expect(existsSync(dir)).toBe(false);
  expect(stderr.filter((line) => line.includes("cannot write"))).toHaveLength(1);
  expect(stderr.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line).message)).toEqual(["to stderr", "to stderr too"]);
});
