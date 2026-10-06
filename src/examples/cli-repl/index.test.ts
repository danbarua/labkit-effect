/**
 * The CLI, run as a process and, for the terminal cases, in this process. These cover what needs no
 * provider: the models list, and the errors when no model can be used. Requests to a model are
 * checked live (`bun cli -p`).
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer, Stdio, Terminal } from "effect";
import { CliOutput, Command } from "effect/cli";
import { TestConsole } from "effect/testing";
import { Brand, defaultBrand } from "../../agent-host/brand.ts";
import { type CatalogSource, ModelCatalog } from "../../agent-host/catalog.ts";
import { sessionFolderOf } from "../../agent-host/directory.ts";
import { ModelName, ProviderName } from "../../agent-machine/names.ts";
import { runTest } from "../../../tests/support/run.ts";
import { typing } from "../../../tests/support/terminal.ts";
import { test, testFolder } from "../../../tests/support/test.ts";
import { cliOf, withResumeValue } from "./index.ts";
import { saidFormatter } from "./invalid.ts";
import { storeFolder } from "./session.ts";

const invoke = async (args: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  // Run in the test's folder, where the CLI writes its logs and sessions.
  const child = Bun.spawn([process.execPath, new URL("./index.ts", import.meta.url).pathname, ...args], {
    cwd: testFolder(),
    stdin: new Blob([""]),
    stdout: "pipe",
    stderr: "pipe",
    // The test's folder is its home too, so the user's own configuration (~/.config/labkit) is not read.
    env: { PATH: process.env["PATH"] ?? "", HOME: testFolder(), NO_COLOR: "1", FORCE_COLOR: "0", ...env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
};

test("models prints the usable models one per line, and on stderr a hint for each provider without an API key", async () => {
  const { stdout, stderr, code } = await invoke(["models"], { OPENAI_API_KEY: "set" });
  const lines = stdout.trim().split("\n");
  expect(code).toBe(0);
  expect(lines).toContain("openai/gpt-5.5");
  // The local server's models are listed too when it responds.
  expect(lines.filter((line) => !line.startsWith("openai/") && !line.startsWith("localhost/"))).toEqual([]);
  // When the local server is not responding, a hint follows.
  expect(stderr.split("\n").slice(0, 2)).toEqual(["HINT: Set ANTHROPIC_API_KEY to use anthropic models.", "HINT: Set XAI_API_KEY to use xai models."]);
});

test("-p with no model fails with only an ERROR line and a HINT line on stderr", async () => {
  const result = await invoke(["-p", "Hello"]);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("ERROR: --model is required.\nHINT: bun cli models shows available models discovered from the environment.\n");
});

test("an invalid flag value fails with one ERROR line on stderr", async () => {
  const result = await invoke(["-p", "Hello", "--effort", "loud"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toStartWith('ERROR: Invalid value for flag --effort: "loud".');
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
});

test("a command-line setting the model does not support fails before a session opens, listing the supported values", async () => {
  const result = await invoke(["-p", "Hello", "--model", "gpt-5", "--effort", "max"], { OPENAI_API_KEY: "set" });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toBe("ERROR: openai/gpt-5 does not support effort=max (from the command line).\nHINT: Supported: default, minimal, low, medium, high.\n");
  expect(existsSync(join(testFolder(), "logs/cli"))).toBe(false);
});

test("without --model, a new session uses the configured model", async () => {
  mkdirSync(join(testFolder(), ".config", "labkit"), { recursive: true });
  writeFileSync(join(testFolder(), ".config", "labkit", "models.yml"), "model: openai/gpt-5.5\n");
  // No API key is set, so the run fails, and the error names the configured model's provider.
  const result = await invoke(["-p", "Hello"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toStartWith("ERROR: openai models are unavailable: OPENAI_API_KEY is not set.\n");
});

test("an unknown model name fails, suggesting similar usable models", async () => {
  const result = await invoke(["-p", "Hello", "--model", "GPT-5.5-PRO"], { OPENAI_API_KEY: "set" });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toBe("ERROR: Unknown model: GPT-5.5-PRO.\nHINT: Did you mean openai/gpt-5.5-pro? bun cli models lists the models you can use.\n");
});

test("-p with no prompt and nothing on stdin fails", async () => {
  const result = await invoke(["-p", "--model", "gpt-5.5"], { OPENAI_API_KEY: "set" });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toBe("ERROR: No prompt given.\nHINT: Pass the prompt as an argument, or pipe it to stdin.\n");
});

test("a model whose provider has no API key fails, naming the missing variable", async () => {
  const result = await invoke(["-p", "Hello", "--model", "gpt-5.5"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toBe("ERROR: openai models are unavailable: OPENAI_API_KEY is not set.\nHINT: Set OPENAI_API_KEY, or choose another model with --model.\n");
});

test("an invalid configuration fails before any request, naming the file at fault", async () => {
  const result = await invoke(["-p", "Hello", "--settings", '{"toolCalls": ["loopBraker"]}']);
  expect(result.code).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('Invalid configuration: --settings: toolCalls[0]: "loopBraker" is neither in plugins nor a plug-in');
});

test("a required MCP server that fails to start stops the session from opening, and the error says why", async () => {
  const servers = JSON.stringify({ mcpServers: { missing: { command: "/no/such/server", required: true } } });
  const result = await invoke(["-p", "Hello", "--model", "gpt-5.5", "--mcp-config", servers], { OPENAI_API_KEY: "set" });
  expect(result.code).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("Required MCP servers are not running: missing (it failed: its process could not be started:");
  // The resolved configuration was written to the session's folder before the failure.
  const sessions = join(testFolder(), "logs/cli");
  const [session] = readdirSync(sessions);
  const effective = JSON.parse(readFileSync(join(sessions, session ?? "", "effective-settings.json"), "utf8")) as { readonly layers: ReadonlyArray<{ readonly name: string }>; readonly host: { readonly model: string }; readonly mcpServers: ReadonlyArray<{ readonly required: boolean }> };
  expect(effective.layers.map((layer) => layer.name)).toEqual(["the CLI's defaults", "--mcp-config", "the command line"]);
  expect(effective.host.model).toBe("openai/gpt-5.5");
  expect(effective.mcpServers.map((server) => server.required)).toEqual([true]);
});

test("--resume with no ID is given an empty ID, so the CLI offers a session picker", () => {
  expect(withResumeValue(["--resume"])).toEqual(["--resume", ""]);
  expect(withResumeValue(["-r", "--model", "gpt-5.5"])).toEqual(["-r", "", "--model", "gpt-5.5"]);
  expect(withResumeValue(["--resume", "abc", "-p", "hi"])).toEqual(["--resume", "abc", "-p", "hi"]);
});

/** A catalog of `sources`, so that the usable models depend on neither the environment nor a local server. */
const catalogOf = (sources: ReadonlyArray<CatalogSource>) => Layer.succeed(ModelCatalog, { sources: Effect.succeed(sources) });

const openai: CatalogSource = { provider: ProviderName.make("openai"), models: [ModelName.make("gpt-5.5")] };

/**
 * Runs the CLI in this process with `args`, a terminal that types `lines`, a catalog of OpenAI's
 * models, and the test's folder as the configuration folder. Returns how it exited, and what it
 * printed to stdout and stderr.
 */
const atTerminal = (args: ReadonlyArray<string>, lines: ReadonlyArray<string>) =>
  runTest(
    Effect.gen(function* () {
      const exit = yield* Command.runWith(cliOf(defaultBrand), { version: "test" })([...args, "--config-dir", testFolder()]).pipe(
        Effect.provideService(Terminal.Terminal, yield* typing(lines)),
        Effect.exit,
      );
      return { exit, logged: yield* TestConsole.logLines, errors: yield* TestConsole.errorLines };
    }).pipe(
      Effect.provide(Stdio.layerTest({ stdinIsTerminal: Effect.succeed(true) })),
      Effect.provideService(Brand, defaultBrand),
      Effect.provide(Layer.mergeAll(BunServices.layer, catalogOf([openai]), TestConsole.layer, CliOutput.layer(saidFormatter))),
    ),
  );

test("at a terminal with no model, the REPL opens without a model, and /exit saves no session", async () => {
  const id = crypto.randomUUID();
  const { exit, logged } = await atTerminal(["--session-id", id], ["/exit"]);
  expect(Exit.isSuccess(exit)).toBe(true);
  expect(logged).toEqual(["No model selected · /model to pick one · /help for commands · /exit to quit", "ERROR: No model selected.\nHINT: Pick one with /model."]);
  expect(existsSync(sessionFolderOf(storeFolder, id))).toBe(false);
});

test("at a terminal, a model without an API key opens the REPL without a model, with a hint to use /model", async () => {
  const { logged } = await atTerminal(["--model", "grok-4.7"], ["/exit"]);
  expect(logged[1]).toBe("ERROR: xai models are unavailable: XAI_API_KEY is not set.\nHINT: Pick another model with /model, or set XAI_API_KEY and restart.");
});

test("-p at a terminal with no model fails at once, with a hint about --model rather than /model", async () => {
  const { exit, logged, errors } = await atTerminal(["-p", "Hello"], []);
  expect(Exit.isFailure(exit)).toBe(true);
  expect(logged).toEqual([]);
  expect(errors).toEqual(["ERROR: --model is required.\nHINT: bun cli models shows available models discovered from the environment."]);
});
