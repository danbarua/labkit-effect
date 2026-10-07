/** The level a program logs at, from `LABKIT_LOG_LEVEL`, and the warning for a value that names no level. */

import { expect } from "bun:test";
import { Effect, Logger, LogLevel } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { logLevelOf, withLogLevel } from "./log-level.ts";

test.each([
  ["all", "All"],
  ["trace", "Trace"],
  ["DEBUG", "Debug"],
  ["Info", "Info"],
  ["warn", "Warn"],
  ["Warning", "Warn"],
  ["ERROR", "Error"],
  ["fatal", "Fatal"],
  ["none", "None"],
] as const)("LABKIT_LOG_LEVEL=%p, any name --log-level takes, in any case, is the level %p, with nothing to report", (value, level) => {
  expect(logLevelOf({ LABKIT_LOG_LEVEL: value })).toEqual({ level, invalid: [] });
});

test("with LABKIT_LOG_LEVEL unset or empty, the level is info, with nothing to report", () => {
  expect(logLevelOf({})).toEqual({ level: "Info", invalid: [] });
  expect(logLevelOf({ LABKIT_LOG_LEVEL: "" })).toEqual({ level: "Info", invalid: [] });
});

test.each(["loud", "warnings", "constructor", " debug"])("a value that names no level (%p) gives info, and is listed with its variable to be reported", (value) => {
  expect(logLevelOf({ LABKIT_LOG_LEVEL: value })).toEqual({ level: "Info", invalid: [{ variable: "LABKIT_LOG_LEVEL", value }] });
});

test("the variable follows the brand: ACME_LOG_LEVEL for acme, given or named by LABKIT_BRAND; another brand's is not read", () => {
  expect(logLevelOf({ ACME_LOG_LEVEL: "error", LABKIT_LOG_LEVEL: "trace" }, { name: "acme", version: "1.0.0" }).level).toBe("Error");
  expect(logLevelOf({ LABKIT_BRAND: "acme", ACME_LOG_LEVEL: "error", LABKIT_LOG_LEVEL: "trace" }).level).toBe("Error");
});

/** Runs a program that logs at debug and at info under `withLogLevel` for `env`; gives the lines logged and whether debug was enabled. */
const loggedAt = async (env: Record<string, string>) => {
  const logged: Array<{ readonly level: string; readonly message: unknown }> = [];
  const capture = Logger.layer([Logger.make((options) => logged.push({ level: options.logLevel, message: options.message }))]);
  const debugEnabled = await runTest(
    Effect.gen(function* () {
      yield* Effect.logDebug("d");
      yield* Effect.logInfo("i");
      return yield* LogLevel.isEnabled("Debug");
    }).pipe(Effect.provide(withLogLevel(logLevelOf(env), capture))),
  );
  return { logged, debugEnabled };
};

test("at debug, debug lines are logged and LogLevel.isEnabled(Debug) is true", async () => {
  const { logged, debugEnabled } = await loggedAt({ LABKIT_LOG_LEVEL: "debug" });
  expect(debugEnabled).toBe(true);
  expect(logged.map(({ level }) => level)).toEqual(["Debug", "Info"]);
});

test("a value that names no level is reported once, before the program's lines, with the variable, the value and the level used; debug lines are not logged", async () => {
  const { logged, debugEnabled } = await loggedAt({ LABKIT_LOG_LEVEL: "loud" });
  expect(debugEnabled).toBe(false);
  expect(logged).toEqual([
    { level: "Warn", message: ["host_logs.level_invalid", { variable: "LABKIT_LOG_LEVEL", value: "loud", level: "info" }] },
    { level: "Info", message: ["i"] },
  ]);
});
