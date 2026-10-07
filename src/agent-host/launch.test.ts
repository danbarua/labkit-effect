/** The options both hosts take, each a flag with its variable as its twin, and the layers they make. */

import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Config, ConfigProvider, Effect, Exit } from "effect";
import { Command } from "effect/cli";
import { runTest } from "../../tests/support/run.ts";
import { test, testFolder } from "../../tests/support/test.ts";
import type { LayerSource } from "../agent-config/file.ts";
import { type Brand, defaultBrand } from "./brand.ts";
import { launchConfiguration, launchFlags, type LaunchOptions, launchVariables } from "./launch.ts";
import { defaultPermissionSettings } from "../agent-policy/permissions.ts";

/** The permissions plug-in's settings in `mode`, the others at their defaults. */
const permissionSettings = (mode: string) => ({ mode, ...defaultPermissionSettings });

/** The options `args` give, the variables being `env`'s for `brand` and `host`; and what a plain variable reads as beside them. */
const launched = (args: ReadonlyArray<string>, env: Readonly<Record<string, string>>, host: ReadonlyArray<string> = [], brand: Brand = defaultBrand) => {
  let seen: { readonly options: LaunchOptions; readonly otel: string | undefined } | undefined;
  const command = Command.make("launched", launchFlags, (options) =>
    Effect.gen(function* () {
      const otel = yield* Config.String("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(Config.withDefault(undefined));
      seen = { options, otel };
    }),
  );
  return runTest(
    Command.runWith(command, { version: "0" })(args).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, launchVariables(brand, host, env)),
      Effect.provide(BunServices.layer),
      Effect.exit,
    ),
  ).then((exit) => ({ exit, seen }));
};

const allTwins = {
  LABKIT_MODEL: "openai/gpt-5.5",
  LABKIT_PERMISSION_MODE: "acceptEdits",
  LABKIT_STRICT_TOOL_INPUT: "1",
  LABKIT_MAX_TURNS: "7",
  LABKIT_MAX_BUDGET_USD: "2.5",
  LABKIT_MCP_CONFIG: '{"mcpServers": {}}',
  LABKIT_STRICT_MCP_CONFIG: "true",
  LABKIT_SETTINGS: '{"maxHolds": 2}',
  LABKIT_SETTING_SOURCES: "user,project",
  LABKIT_CONFIG_DIR: "/etc/labkit",
};

test("a flag not given is read from its variable, the brand's prefix and the flag's name in capitals; a flag given wins", async () => {
  expect((await launched([], allTwins)).seen?.options).toEqual({
    model: "openai/gpt-5.5",
    permissionMode: "acceptEdits",
    strictToolInput: true,
    maxTurns: 7,
    maxBudgetUsd: 2.5,
    mcpConfig: ['{"mcpServers": {}}'],
    strictMcpConfig: true,
    settings: '{"maxHolds": 2}',
    settingSources: "user,project",
    configDir: "/etc/labkit",
  });
  const given = await launched(["--model", "xai/grok-4.7", "--max-turns", "3", "--mcp-config", "a.json", "--mcp-config", "b.json"], allTwins);
  expect(given.seen?.options).toMatchObject({ model: "xai/grok-4.7", maxTurns: 3, mcpConfig: ["a.json", "b.json"], permissionMode: "acceptEdits" });
  expect((await launched([], {})).seen?.options).toEqual({
    model: undefined,
    permissionMode: undefined,
    strictToolInput: false,
    maxTurns: undefined,
    maxBudgetUsd: undefined,
    mcpConfig: [],
    strictMcpConfig: false,
    settings: undefined,
    settingSources: undefined,
    configDir: undefined,
  });
});

test("the host's part comes after the brand's prefix (ACP_ for the ACP launcher), and another brand has its own; an empty variable is none", async () => {
  const env = { LABKIT_MAX_TURNS: "1", LABKIT_ACP_MAX_TURNS: "2", WHITELABEL_AGENT_MAX_TURNS: "3", WHITELABEL_AGENT_ACP_MAX_TURNS: "4" };
  expect((await launched([], env)).seen?.options.maxTurns).toBe(1);
  expect((await launched([], env, ["ACP"])).seen?.options.maxTurns).toBe(2);
  const whitelabel = { name: "whitelabel-agent", version: "1.0.0" };
  expect((await launched([], env, [], whitelabel)).seen?.options.maxTurns).toBe(3);
  expect((await launched([], env, ["ACP"], whitelabel)).seen?.options.maxTurns).toBe(4);
  expect((await launched([], { LABKIT_MODEL: "", LABKIT_MAX_TURNS: "" })).seen?.options).toMatchObject({ model: undefined, maxTurns: undefined });
});

test("a variable value that the flag would not accept is the flag's error; a variable that is no flag's twin is read under its own name", async () => {
  const refused = await launched([], { LABKIT_MAX_TURNS: "lots" });
  expect(Exit.isFailure(refused.exit)).toBe(true);
  expect(refused.seen).toBeUndefined();
  expect((await launched([], { LABKIT_PERMISSION_MODE: "yolo" })).seen).toBeUndefined();
  expect((await launched([], { OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318" })).seen?.otel).toBe("http://otel:4318");
});

test("--config-dir, or its variable, names the user's configuration folder in place of ~/.config/<brand>", async () => {
  const home = join(testFolder(), "home");
  mkdirSync(join(home, ".config", "labkit"), { recursive: true });
  writeFileSync(join(home, ".config", "labkit", "policies.yml"), "toolCalls: [permissions]\n");
  mkdirSync(join(testFolder(), "elsewhere"), { recursive: true });
  writeFileSync(join(testFolder(), "elsewhere", "10_mine.yml"), "toolCalls: [loopBreaker]\n");
  const defaults: LayerSource = { name: "the host's defaults", trusted: true, value: {} };
  const configuration = await runTest(
    launchConfiguration(join(testFolder(), "project"), defaults, { mcpConfig: [], strictMcpConfig: false, configDir: join(testFolder(), "elsewhere") }, { home }).pipe(
      Effect.provide(BunServices.layer),
    ),
  );
  expect(configuration.layers.map((layer) => layer.name)).toEqual(["the host's defaults", join(testFolder(), "elsewhere", "10_mine.yml"), "the command line"]);
  expect((await launched([], { LABKIT_CONFIG_DIR: "/etc/labkit" })).seen?.options.configDir).toBe("/etc/labkit");
});

test("the host's defaults are the first layer and the flags the last; manual is the default permission mode", async () => {
  const defaults: LayerSource = { name: "the host's defaults", trusted: true, value: { toolCalls: ["permissions"], modelRequests: [] } };
  const configuration = await runTest(
    launchConfiguration(join(testFolder(), "project"), defaults, { mcpConfig: [], strictMcpConfig: false, permissionMode: "manual", maxTurns: 4 }, { home: join(testFolder(), "home") }).pipe(
      Effect.provide(BunServices.layer),
    ),
  );
  expect(configuration.layers.map((layer) => layer.name)).toEqual(["the host's defaults", "the command line"]);
  expect(Object.fromEntries(Object.entries(configuration.lists).map(([seam, entries]) => [seam, entries.map((entry) => [entry.name, entry.settings])]))).toMatchObject({
    toolCalls: [["permissions", permissionSettings("default")]],
    modelRequests: [["maxTurnRequests", { limit: 4 }]],
  });
});
