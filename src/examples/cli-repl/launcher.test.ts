/** The agent's command: the CLI, started in the folder it runs in, reading that folder's own files only when the folder is trusted. */

import { expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect } from "effect";
import { Command } from "effect/cli";
import { runTest } from "../../../tests/support/run.ts";
import { test, testFolder } from "../../../tests/support/test.ts";
import { defaultBrand } from "../../agent-host/brand.ts";
import { launchFlags, launchVariables } from "../../agent-host/launch.ts";
import { asksTrust, cliCommandLine, configDirOf, ownFilesOf } from "./launcher.ts";

test("a folder's own files are its .env files and its project settings folder; .envrc and a file named .labkit are not", () => {
  const entries = [
    { name: ".env", folder: false },
    { name: ".env.local", folder: false },
    { name: ".envrc", folder: false },
    { name: ".labkit", folder: true },
    { name: ".git", folder: true },
    { name: "src", folder: true },
  ];
  expect(ownFilesOf(entries, defaultBrand)).toEqual([".env", ".env.local", ".labkit/"]);
  expect(ownFilesOf([{ name: ".labkit", folder: false }], defaultBrand)).toEqual([]);
  expect(ownFilesOf(entries, { name: "acme", version: "1" })).toEqual([".env", ".env.local"]);
});

test("the command asks about trust only at a terminal, and not when the CLI is to answer once or print its help or version", () => {
  expect(asksTrust([], true)).toBe(true);
  expect(asksTrust(["--model", "x/y", "Hello"], true)).toBe(true);
  expect(asksTrust([], false)).toBe(false);
  for (const flag of ["-p", "--print", "-h", "--help", "-v", "--version"]) expect(asksTrust([flag], true)).toBe(false);
});

/** Returns the config folder that the shared flags, as the CLI parses them, give for `args` and `env`. */
const parsedConfigDir = (args: ReadonlyArray<string>, env: Readonly<Record<string, string>>) => {
  const seen: Array<string | undefined> = [];
  const command = Command.make("parsed", launchFlags, (options) => Effect.sync(() => seen.push(options.configDir)));
  return runTest(
    Command.runWith(command, { version: "0" })(args).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, launchVariables(defaultBrand, [], env)),
      Effect.provide(BunServices.layer),
    ),
  ).then(() => seen[0]);
};

test("the command finds the user's configuration folder as the CLI's flags do: --config-dir, in either form, over its variable, an empty variable counting as not set", async () => {
  const cases: ReadonlyArray<readonly [ReadonlyArray<string>, Record<string, string>]> = [
    [[], {}],
    [["--config-dir", "/from/flag"], {}],
    [["--config-dir=/from/flag"], {}],
    [[], { LABKIT_CONFIG_DIR: "/from/variable" }],
    [["--config-dir", "/from/flag"], { LABKIT_CONFIG_DIR: "/from/variable" }],
    [[], { LABKIT_CONFIG_DIR: "" }],
  ];
  for (const [args, env] of cases) expect(configDirOf(args, env, defaultBrand)).toBe(await parsedConfigDir(args, env));
});

test("the CLI starts without the folder's .env files unless the folder is trusted, and always with the agent's own bunfig", () => {
  const start = { bun: "/bin/bun", bunfig: "/agent/bunfig.toml", entry: "/agent/index.ts", args: ["-p", "Hello"] };
  expect(cliCommandLine({ ...start, trusted: false })).toEqual(["/bin/bun", "--no-env-file", "--config=/agent/bunfig.toml", "/agent/index.ts", "-p", "Hello"]);
  expect(cliCommandLine({ ...start, trusted: true })).toEqual(["/bin/bun", "--config=/agent/bunfig.toml", "/agent/index.ts", "-p", "Hello"]);
});

test("run in a folder that is not trusted, the command reads neither its .env nor its bunfig.toml, and says so; in a trusted folder Bun loads its .env, and still not its bunfig.toml", async () => {
  const project = join(testFolder(), "project");
  const config = join(testFolder(), "config");
  mkdirSync(project, { recursive: true });
  mkdirSync(config, { recursive: true });
  // A .env whose settings load an extension, and a bunfig.toml that preloads a file: each writes a marker when it runs.
  writeFileSync(join(project, ".env"), "LABKIT_SETTINGS=./settings.yml\n");
  writeFileSync(join(project, "settings.yml"), "extensions:\n  - ./extension.ts\n");
  writeFileSync(join(project, "extension.ts"), 'await Bun.write(new URL("./extension-ran", import.meta.url), "");\nexport default [];\n');
  writeFileSync(join(project, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  writeFileSync(join(project, "preload.ts"), 'await Bun.write(new URL("./preload-ran", import.meta.url), "");\n');
  const command = new URL("../../../bin/labkit.ts", import.meta.url).pathname;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("LABKIT_")));
  const run = async () => {
    const cli = Bun.spawn([command, "-p", "Hello", "--model", "nosuch/model", "--config-dir", config], { cwd: project, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    await cli.exited;
    return await new Response(cli.stderr).text();
  };
  const untrusted = await run();
  expect(untrusted).toStartWith("Not reading .env in this folder, which is not trusted. Start labkit here at a terminal to trust it.\n");
  expect(untrusted).toContain("ERROR: Unknown model: nosuch/model.");
  expect([existsSync(join(project, "extension-ran")), existsSync(join(project, "preload-ran"))]).toEqual([false, false]);
  writeFileSync(join(config, "trusted-folders.json"), JSON.stringify({ folders: [project] }));
  const trusted = await run();
  expect(trusted).not.toContain("Not reading");
  expect([existsSync(join(project, "extension-ran")), existsSync(join(project, "preload-ran"))]).toEqual([true, false]);
});
