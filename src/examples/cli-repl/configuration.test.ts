/** The CLI's configuration: its defaults, the files, --settings, the MCP servers' flags, then the other flags, merged in that order. */

import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { runTest } from "../../../tests/support/run.ts";
import { test, testFolder } from "../../../tests/support/test.ts";
import type { Configuration } from "../../agent-config/file.ts";
import { cliConfiguration, type ConfigFlags } from "./configuration.ts";

const write = (path: string, text: string): string => {
  const full = join(testFolder(), path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
  return full;
};

const none: ConfigFlags = { mcpConfig: [], strictMcpConfig: false };

/** The configuration a CLI run in the test's `project` folder gets with `flags`, the user's home being the test's `home`. */
const configured = (flags: Partial<ConfigFlags> = {}) =>
  runTest(cliConfiguration(join(testFolder(), "project"), { ...none, ...flags }, { home: join(testFolder(), "home") }).pipe(Effect.provide(BunServices.layer)));

const refused = (flags: Partial<ConfigFlags> = {}) =>
  runTest(
    cliConfiguration(join(testFolder(), "project"), { ...none, ...flags }, { home: join(testFolder(), "home") }).pipe(
      Effect.flip,
      Effect.map((error) => error.message),
      Effect.provide(BunServices.layer),
    ),
  );

const listed = (configuration: Configuration) =>
  Object.fromEntries(Object.entries(configuration.lists).map(([seam, entries]) => [seam, entries.map((entry) => [entry.name, entry.settings])]));

test("with no file and no flag, the CLI's defaults: the loop breaker then permission on tool calls, the loop breaker on model requests, one retry of a turn with no answer", async () => {
  const configuration = await configured();
  expect(listed(configuration)).toEqual({
    toolCalls: [
      ["loopBreaker", { nudgeAt: 3, stopAt: 5, key: "toolAndInput" }],
      ["permissions", { mode: "default" }],
    ],
    modelRequests: [["loopBreaker", { nudgeAt: 3, stopAt: 5, key: "toolAndInput" }]],
    turnEnd: [["retryIncomplete", { retries: 1 }]],
    commandEnvironment: [["credentials", { pass: [] }]],
  });
  expect(configuration.maxHolds).toBe(1);
  expect(configuration.mcpServers).toEqual([]);
});

test("the flags come last: --permission-mode sets permission's mode; --max-turns and --max-budget-usd set their plug-ins, adding them to the model requests' list when it does not have them", async () => {
  const configuration = await configured({ permissionMode: "acceptEdits", maxTurns: 3, maxBudgetUsd: 2.5 });
  expect(listed(configuration)["toolCalls"]?.[1]).toEqual(["permissions", { mode: "acceptEdits" }]);
  expect(listed(configuration)["modelRequests"]).toEqual([
    ["loopBreaker", { nudgeAt: 3, stopAt: 5, key: "toolAndInput" }],
    ["maxTurnRequests", { limit: 3 }],
    ["maxBudget", { usd: 2.5 }],
  ]);
  // A file that lists the limit already keeps its place for it; the flag sets its limit.
  write("project/.labkit/policies.yml", "modelRequests: [maxTurnRequests, loopBreaker]\n");
  expect(listed(await configured({ maxTurns: 7 }))["modelRequests"]).toEqual([
    ["maxTurnRequests", { limit: 7 }],
    ["loopBreaker", { nudgeAt: 3, stopAt: 5, key: "toolAndInput" }],
  ]);
  expect(await refused({ maxTurns: 0 })).toBe('the command line: plugins.maxTurnRequests.limit: Expected a value greater than or equal to 1 at ["limit"]');
});

test("--settings is a layer over the files, JSON or a file of YAML or JSON; --setting-sources says which files are read", async () => {
  write("home/.config/labkit/policies.yml", "plugins:\n  loopBreaker:\n    nudgeAt: 4\n");
  write("project/.labkit/policies.yml", "plugins:\n  loopBreaker:\n    stopAt: 9\n");
  const both = listed(await configured({ settings: '{"plugins": {"loopBreaker": {"key": "toolAndInput", "nudgeAt": 2}}}' }));
  expect(both["toolCalls"]?.[0]).toEqual(["loopBreaker", { nudgeAt: 2, stopAt: 9, key: "toolAndInput" }]);
  const yaml = write("settings.yml", "toolCalls: [permissions]\n");
  expect(listed(await configured({ settings: yaml }))["toolCalls"]).toEqual([["permissions", { mode: "default" }]]);
  const json = write("settings.json", JSON.stringify({ toolCalls: ["loopBreaker"] }, null, 2));
  expect(listed(await configured({ settings: json }))["toolCalls"]).toEqual([["loopBreaker", { nudgeAt: 4, stopAt: 9, key: "toolAndInput" }]]);
  expect(listed(await configured({ settingSources: "user" }))["toolCalls"]?.[0]).toEqual(["loopBreaker", { nudgeAt: 4, stopAt: 5, key: "toolAndInput" }]);
  expect(await refused({ settingSources: "user,team" })).toBe('--setting-sources: "team" is not a source; those are: user, project, local');
  expect(await refused({ settings: '{"toolCalls": ["nobody"]}' })).toStartWith('--settings: toolCalls[0]: "nobody" is neither in plugins nor a plug-in');
});

test("--mcp-config adds MCP servers, as Claude Code's .mcp.json; with --strict-mcp-config they are the only ones", async () => {
  write("home/.config/labkit/policies.yml", "mcpServers:\n  files:\n    command: files-mcp\n");
  const config = '{"mcpServers": {"github": {"type": "stdio", "command": "gh-mcp", "args": ["stdio"], "env": {"TOKEN": "x"}}}}';
  const names = (configuration: Configuration) => configuration.mcpServers.map((server) => [server.name, server.command, server.args, server.env]);
  expect(names(await configured({ mcpConfig: [config] }))).toEqual([
    ["files", "files-mcp", [], {}],
    ["github", "gh-mcp", ["stdio"], { TOKEN: "x" }],
  ]);
  expect(names(await configured({ mcpConfig: [config], strictMcpConfig: true }))).toEqual([["github", "gh-mcp", ["stdio"], { TOKEN: "x" }]]);
  expect(names(await configured({ strictMcpConfig: true }))).toEqual([]);
  const file = write("mcp.json", JSON.stringify({ mcpServers: { db: { command: "db-mcp" } } }, null, 2));
  expect(names(await configured({ mcpConfig: [config, file], strictMcpConfig: true }))).toEqual([
    ["github", "gh-mcp", ["stdio"], { TOKEN: "x" }],
    ["db", "db-mcp", [], {}],
  ]);
});

test("a project's file that names extensions is refused: it comes with the project, and does not run code", async () => {
  write("project/.labkit/policies.yml", "extensions: [./mine.ts]\n");
  expect(await refused()).toEndWith("project/.labkit/policies.yml: extensions: Extensions are loaded only from the user's own configuration: a project's does not run code");
});
