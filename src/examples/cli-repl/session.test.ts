/**
 * What the CLI records of a session, which stored sessions `--continue` and the `--resume` picker
 * offer, what a CLI session's log lines carry, and the environment that a CLI session's MCP servers
 * receive.
 */

import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Logger, References } from "effect";
import { runTest } from "../../../tests/support/run.ts";
import { test, testFolder } from "../../../tests/support/test.ts";
import { type LayerSource, loadConfiguration } from "../../agent-config/file.ts";
import { defaultBrand } from "../../agent-host/brand.ts";
import { brandFoldersLayer, brandFoldersOf } from "../../agent-host/brand-folders.ts";
import { Headless } from "../../agent-host/with-session.ts";
import { ModelName, ProviderName } from "../../agent-machine/names.ts";
import { logKeys as processLogKeys } from "../../agent-process/log-keys.ts";
import { withoutCredentials } from "../../agent-process/environment.ts";
import { cliDefaults } from "./configuration.ts";
import { cliRecord, type Config, madeIn, withCliSession } from "./session.ts";

test("a session counts as made in a folder only when its record names the CLI and that folder", () => {
  expect(cliRecord("/work/a")).toEqual({ host: "cli", cwd: "/work/a" });
  expect(madeIn(cliRecord("/work/a"), "/work/a")).toBe(true);
  expect(madeIn(cliRecord("/work/a"), "/work/b")).toBe(false);
  expect(madeIn({ host: "acp", cwd: "/work/a" }, "/work/a")).toBe(false);
  expect(madeIn(undefined, "/work/a")).toBe(false);
});

test("a log line written inside a CLI session carries the session's id (session), whatever writes it", async () => {
  const logged: Array<{ readonly message: unknown; readonly session: unknown }> = [];
  const capture = Logger.make((options) => {
    logged.push({ message: options.message, session: options.fiber.getRef(References.CurrentLogAnnotations)["session"] });
  });
  const configuration = { ...(await runTest(loadConfiguration([]))), layers: [] };
  const config: Config = {
    sessionId: "cli-logged",
    target: { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5") },
    settings: {},
    system: undefined,
    persist: false,
    configuration,
    canAsk: false,
    additionalFolders: [],
    strictToolInput: false,
  };
  await runTest(
    withCliSession(config, Logger.layer([capture], { mergeWithExisting: true }), Headless, () => Effect.logInfo("test.inside_the_session")).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, brandFoldersLayer(brandFoldersOf(defaultBrand, { home: testFolder() })))),
    ),
  );
  // The loop names the session on what it records; the line from the session's own work is named by the session's context.
  const inside = logged.filter(({ message }) => JSON.stringify(message).includes("test.inside_the_session"));
  expect(inside.map(({ session }) => session)).toEqual(["cli-logged"]);
  const recorded = logged.filter(({ message }) => JSON.stringify(message).includes("loop.observation.recorded"));
  expect(recorded.length).toBeGreaterThan(0);
  expect(recorded.every(({ session }) => session === "cli-logged")).toBe(true);
});

/** A credential variable of this process, which the default command environment removes. */
const passedToken = "LABKIT_CLI_MCP_TEST_TOKEN";

/**
 * Runs a CLI session `sessionId` whose configuration is the CLI's defaults, then `layer`, then an MCP
 * stdio server, the test's server, started through a shell that writes the environment it was given
 * to a file. Returns the variables in that file by name, and each log line with its `session`
 * annotation.
 */
const mcpRun = async (sessionId: string, layer: LayerSource["value"]) => {
  process.env[passedToken] = "passed";
  const file = join(testFolder(), `${sessionId}-env.txt`);
  const server = new URL("../../../tests/support/mcp-server.ts", import.meta.url).pathname;
  const servers: LayerSource = {
    name: "the test's servers",
    trusted: true,
    value: { mcpServers: { fake: { command: "/bin/sh", args: ["-c", `env > "${file}"; exec "$0" "$1"`, process.execPath, server] } } },
  };
  const layers: ReadonlyArray<LayerSource> = [cliDefaults, { name: "the test's settings", trusted: true, value: layer }, servers];
  const configuration = { ...(await runTest(loadConfiguration(layers))), layers };
  const logged: Array<{ readonly message: unknown; readonly session: unknown }> = [];
  const capture = Logger.make((options) => {
    logged.push({ message: options.message, session: options.fiber.getRef(References.CurrentLogAnnotations)["session"] });
  });
  const config: Config = {
    sessionId,
    target: { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5") },
    settings: {},
    system: undefined,
    persist: false,
    configuration,
    canAsk: false,
    additionalFolders: [],
    strictToolInput: false,
  };
  await runTest(
    withCliSession(config, Logger.layer([capture], { mergeWithExisting: true }), Headless, () => Effect.void).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, brandFoldersLayer(brandFoldersOf(defaultBrand, { home: testFolder() })))),
    ),
  );
  const variables = new Map(readFileSync(file, "utf8").split("\n").flatMap((line) => (line.includes("=") ? [[line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const] : [])));
  return { variables, logged };
};

test("an MCP stdio server of a CLI session receives a credential variable that the configured command environment passes and the default removes", async () => {
  const { variables } = await mcpRun("cli-mcp-passed", { plugins: { credentials: { pass: [passedToken] } } });
  // The variable is one that this process's environment without its credentials does not have.
  expect(withoutCredentials(process.env).removed).toContain(passedToken);
  expect(variables.get(passedToken)).toBe("passed");
});

test("under the default command environment, an MCP stdio server of a CLI session does not receive a credential variable of this process", async () => {
  const { variables } = await mcpRun("cli-mcp-default", {});
  expect(withoutCredentials(process.env).removed).toContain(passedToken);
  expect(variables.has(passedToken)).toBe(false);
  expect(variables.has("PATH")).toBe(true);
});

test("the log lines of a CLI session's MCP server carry the session's id (session)", async () => {
  const { logged } = await mcpRun("cli-mcp-logged", {});
  const environment = logged.filter(({ message }) => Array.isArray(message) && message[0] === processLogKeys.process.environment);
  expect(environment.map(({ session }) => session)).toEqual(["cli-mcp-logged"]);
});
