/** The CLI's configuration: its defaults, the files, --settings, the MCP servers' flags, then the other flags, merged in that order. */

import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { runTest } from "../../../tests/support/run.ts";
import { test, testFolder } from "../../../tests/support/test.ts";
import type { Configuration } from "../../agent-config/file.ts";
import type { ConfigFlags } from "../../agent-host/launch.ts";
import { cliConfiguration } from "./configuration.ts";
import { defaultPermissionSettings } from "../../agent-policy/permissions.ts";

/** The permissions plug-in's settings in `mode`, the others at their defaults. */
const permissionSettings = (mode: string) => ({ mode, ...defaultPermissionSettings, additionalDirectories: [] });

const write = (path: string, text: string): string => {
  const full = join(testFolder(), path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
  return full;
};

const none: ConfigFlags = { mcpConfig: [], strictMcpConfig: false };

/** Returns the configuration for a CLI run in the test's `project` folder with `flags`, using the test's `home` as the user's home. */
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

/** Adds the test's project folder to the trusted folders of the test's user. */
const trustProject = () => write("home/.config/labkit/trusted-folders.json", JSON.stringify({ folders: [join(testFolder(), "project")] }));

const listed = (configuration: Configuration) =>
  Object.fromEntries(Object.entries(configuration.lists).map(([seam, entries]) => [seam, entries.map((entry) => [entry.name, entry.settings])]));

test("with no configuration file and no flag, tool calls go through the loop breaker then permission, model requests through the loop breaker, and a turn with no answer is retried once", async () => {
  const configuration = await configured();
  expect(listed(configuration)).toEqual({
    toolCalls: [
      ["loopBreaker", { nudgeAt: 3, stopAt: 5, key: "toolAndInput" }],
      ["permissions", permissionSettings("default")],
    ],
    modelRequests: [["loopBreaker", { nudgeAt: 3, stopAt: 5, key: "toolAndInput" }]],
    turnEnd: [["retryIncomplete", { retries: 1 }]],
    commandEnvironment: [["credentials", { pass: [] }]],
  });
  expect(configuration.maxHolds).toBe(1);
  expect(configuration.mcpServers).toEqual([]);
});

test("flags override the files: --permission-mode sets the permission mode, and --max-turns and --max-budget-usd add their limits to model requests", async () => {
  const configuration = await configured({ permissionMode: "acceptEdits", maxTurns: 3, maxBudgetUsd: 2.5 });
  expect(listed(configuration)["toolCalls"]?.[1]).toEqual(["permissions", permissionSettings("acceptEdits")]);
  expect(listed(configuration)["modelRequests"]).toEqual([
    ["loopBreaker", { nudgeAt: 3, stopAt: 5, key: "toolAndInput" }],
    ["maxTurnRequests", { limit: 3 }],
    ["maxBudget", { usd: 2.5 }],
  ]);
  // When a file already lists the limit, the flag sets its value and the limit keeps its position.
  write("project/.labkit/policies.yml", "modelRequests: [maxTurnRequests, loopBreaker]\n");
  trustProject();
  expect(listed(await configured({ maxTurns: 7, settingSources: "user,project" }))["modelRequests"]).toEqual([
    ["maxTurnRequests", { limit: 7 }],
    ["loopBreaker", { nudgeAt: 3, stopAt: 5, key: "toolAndInput" }],
  ]);
  expect(await refused({ maxTurns: 0 })).toBe('the command line: plugins.maxTurnRequests.limit: Expected a value greater than or equal to 1 at ["limit"]');
});

test("--settings (JSON, or a JSON or YAML file) overrides the files; --setting-sources chooses which files are read, only the user's by default", async () => {
  write("home/.config/labkit/policies.yml", "plugins:\n  loopBreaker:\n    nudgeAt: 4\n");
  write("project/.labkit/policies.yml", "plugins:\n  loopBreaker:\n    stopAt: 9\n");
  trustProject();
  const both = listed(await configured({ settingSources: "user,project", settings: '{"plugins": {"loopBreaker": {"key": "toolAndInput", "nudgeAt": 2}}}' }));
  expect(both["toolCalls"]?.[0]).toEqual(["loopBreaker", { nudgeAt: 2, stopAt: 9, key: "toolAndInput" }]);
  const yaml = write("settings.yml", "toolCalls: [permissions]\n");
  expect(listed(await configured({ settings: yaml }))["toolCalls"]).toEqual([["permissions", permissionSettings("default")]]);
  const json = write("settings.json", JSON.stringify({ toolCalls: ["loopBreaker"] }, null, 2));
  expect(listed(await configured({ settingSources: "user,project", settings: json }))["toolCalls"]).toEqual([["loopBreaker", { nudgeAt: 4, stopAt: 9, key: "toolAndInput" }]]);
  // The project's file is ignored unless --setting-sources names it.
  expect(listed(await configured())["toolCalls"]?.[0]).toEqual(["loopBreaker", { nudgeAt: 4, stopAt: 5, key: "toolAndInput" }]);
  expect(await refused({ settingSources: "user,team" })).toBe('--setting-sources: "team" is not a source; those are: user, project, local');
  expect(await refused({ settings: '{"toolCalls": ["nobody"]}' })).toStartWith('--settings: toolCalls[0]: "nobody" is neither in plugins nor a plug-in');
});

test("--mcp-config adds MCP servers in Claude Code's .mcp.json format; with --strict-mcp-config they replace all others", async () => {
  write("home/.config/labkit/policies.yml", "mcpServers:\n  files:\n    command: files-mcp\n");
  const config = '{"mcpServers": {"github": {"type": "stdio", "command": "gh-mcp", "args": ["stdio"], "env": {"TOKEN": "x"}}}}';
  const names = (configuration: Configuration) => configuration.mcpServers.map((server) => ("url" in server ? [server.name, server.url] : [server.name, server.command, server.args, server.env]));
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

test("a project's files are read only when --setting-sources names them and the folder is trusted; in a trusted folder they may load extensions", async () => {
  write("project/.labkit/policies.yml", "toolCalls: [loopBreaker]\nplugins:\n  credentials:\n    pass: [ANTHROPIC_API_KEY]\n");
  const unread = listed(await configured());
  expect(unread["toolCalls"]?.map(([name]) => name)).toEqual(["loopBreaker", "permissions"]);
  expect(unread["commandEnvironment"]).toEqual([["credentials", { pass: [] }]]);
  // Named in a folder that is not trusted, the project's files and the local ones are refused, not ignored.
  expect(await refused({ settingSources: "user,project" })).toBe(`${join(testFolder(), "project")} is not trusted, so its settings are not read.`);
  expect(await refused({ settingSources: "local" })).toBe(`${join(testFolder(), "project")} is not trusted, so its settings are not read.`);
  trustProject();
  const extension = new URL("../../../tests/support/config-extension.ts", import.meta.url).pathname;
  write("project/.labkit/policies.yml", `extensions:\n  - ${extension}\nplugins:\n  denyTools:\n    tools: [change]\ntoolCalls: [denyTools, permissions]\n`);
  expect(listed(await configured({ settingSources: "user,project" }))["toolCalls"]).toEqual([
    ["denyTools", { tools: ["change"] }],
    ["permissions", permissionSettings("default")],
  ]);
});

test("a folder inside a trusted folder is trusted; a list of trusted folders that cannot be decoded, and a relative --config-dir, are refused", async () => {
  write("home/.config/labkit/trusted-folders.json", JSON.stringify({ folders: [testFolder()] }));
  write("project/.labkit/policies.yml", "maxHolds: 3\n");
  expect((await configured({ settingSources: "user,project" })).maxHolds).toBe(3);
  write("home/.config/labkit/trusted-folders.json", JSON.stringify({ folders: ["project"] }));
  expect(await refused()).toEndWith("trusted-folders.json: Not an absolute path: project");
  write("home/.config/labkit/trusted-folders.json", "folders: [a]\n");
  expect(await refused()).toStartWith(`${join(testFolder(), "home/.config/labkit/trusted-folders.json")}: Not JSON:`);
  expect(await refused({ configDir: "config" })).toBe("--config-dir: Not an absolute path: config");
});
