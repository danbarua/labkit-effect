/**
 * The command-line agent, run as a process, and at a terminal in this process. These cover what
 * needs no provider: the models list, and what it says when there is nothing to ask. Asking a model
 * is checked live (`bun cli -p`).
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
  // Run in the test's folder, where what the CLI writes (its logs, its sessions) is kept.
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

test("models lists the models that can be asked, one per line as --model takes them, and says on stderr which providers have no key set", async () => {
  const { stdout, stderr, code } = await invoke(["models"], { OPENAI_API_KEY: "set" });
  const lines = stdout.trim().split("\n");
  expect(code).toBe(0);
  expect(lines).toContain("openai/gpt-5.5");
  // The local server's models are listed too when it answers.
  expect(lines.filter((line) => !line.startsWith("openai/") && !line.startsWith("localhost/"))).toEqual([]);
  // Then, when the local server is not answering, a line saying so.
  expect(stderr.split("\n").slice(0, 2)).toEqual(["HINT: Set ANTHROPIC_API_KEY to use anthropic models.", "HINT: Set XAI_API_KEY to use xai models."]);
});

test("print mode with no model is refused: an ERROR line and a HINT line on stderr, and nothing else", async () => {
  const result = await invoke(["-p", "Hello"]);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("ERROR: --model is required.\nHINT: bun cli models shows available models discovered from the environment.\n");
});

test("a flag value the flag does not take is said as an ERROR line on stderr", async () => {
  const result = await invoke(["-p", "Hello", "--effort", "loud"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toStartWith('ERROR: Invalid value for flag --effort: "loud".');
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
});

test("a setting on the command line that the model does not take fails the run before a session opens, saying what the model takes", async () => {
  const result = await invoke(["-p", "Hello", "--model", "gpt-5", "--effort", "max"], { OPENAI_API_KEY: "set" });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toBe("ERROR: openai/gpt-5 does not take effort=max (from the command line).\nHINT: effort takes default, minimal, low, medium, high.\n");
  expect(existsSync(join(testFolder(), "logs/cli"))).toBe(false);
});

test("with no --model, a new session asks the model the configuration names", async () => {
  mkdirSync(join(testFolder(), ".config", "labkit"), { recursive: true });
  writeFileSync(join(testFolder(), ".config", "labkit", "models.yml"), "model: openai/gpt-5.5\n");
  // No key is set, so the model is not asked: the message shows which model was chosen.
  const result = await invoke(["-p", "Hello"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toStartWith("ERROR: OPENAI_API_KEY is not set, so openai models cannot be asked.\n");
});

test("a name that is no model is refused, with the names it is close to among the models that can be asked", async () => {
  const result = await invoke(["-p", "Hello", "--model", "GPT-5.5-PRO"], { OPENAI_API_KEY: "set" });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toBe("ERROR: No model is named GPT-5.5-PRO.\nHINT: Did you mean openai/gpt-5.5-pro? bun cli models shows available models.\n");
});

test("print mode with no prompt and nothing piped is refused", async () => {
  const result = await invoke(["-p", "--model", "gpt-5.5"], { OPENAI_API_KEY: "set" });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toBe("ERROR: No prompt.\nHINT: Pass one as an argument, or pipe it in.\n");
});

test("a model whose provider has no key set is not asked: it names the variable", async () => {
  const result = await invoke(["-p", "Hello", "--model", "gpt-5.5"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toBe("ERROR: OPENAI_API_KEY is not set, so openai models cannot be asked.\nHINT: Set OPENAI_API_KEY, or name another model with --model.\n");
});

test("a configuration that cannot be used is said, naming the layer, before any model is asked", async () => {
  const result = await invoke(["-p", "Hello", "--settings", '{"toolCalls": ["loopBraker"]}']);
  expect(result.code).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('The configuration cannot be used: --settings: toolCalls[0]: "loopBraker" is neither in plugins nor a plug-in');
});

test("an MCP server the configuration says is required, which does not start, keeps the session from opening, saying why", async () => {
  const servers = JSON.stringify({ mcpServers: { missing: { command: "/no/such/server", required: true } } });
  const result = await invoke(["-p", "Hello", "--model", "gpt-5.5", "--mcp-config", servers], { OPENAI_API_KEY: "set" });
  expect(result.code).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("The session needs MCP servers that are not running: missing (it failed: its process could not be started:");
  // What its configuration resolved to was written to the session's folder first.
  const sessions = join(testFolder(), "logs/cli");
  const [session] = readdirSync(sessions);
  const effective = JSON.parse(readFileSync(join(sessions, session ?? "", "effective-settings.json"), "utf8")) as { readonly layers: ReadonlyArray<{ readonly name: string }>; readonly host: { readonly model: string }; readonly mcpServers: ReadonlyArray<{ readonly required: boolean }> };
  expect(effective.layers.map((layer) => layer.name)).toEqual(["the CLI's defaults", "--mcp-config", "the command line"]);
  expect(effective.host.model).toBe("openai/gpt-5.5");
  expect(effective.mcpServers.map((server) => server.required)).toEqual([true]);
});

test("--resume with no id is given an empty one, which asks for a session to be picked", () => {
  expect(withResumeValue(["--resume"])).toEqual(["--resume", ""]);
  expect(withResumeValue(["-r", "--model", "gpt-5.5"])).toEqual(["-r", "", "--model", "gpt-5.5"]);
  expect(withResumeValue(["--resume", "abc", "-p", "hi"])).toEqual(["--resume", "abc", "-p", "hi"]);
});

/** A catalog of `sources`, so that what can be asked depends on neither the environment nor a local server. */
const catalogOf = (sources: ReadonlyArray<CatalogSource>) => Layer.succeed(ModelCatalog, { sources: Effect.succeed(sources) });

const openai: CatalogSource = { provider: ProviderName.make("openai"), models: [ModelName.make("gpt-5.5")] };

/**
 * The CLI run in this process with `args`, its input a terminal typed `lines`, with a catalog of
 * openai's models, and the test's folder as its configuration folder: how it exited, and what it
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

test("at a terminal with no model, the REPL opens without one, and /exit leaves no session behind", async () => {
  const id = crypto.randomUUID();
  const { exit, logged } = await atTerminal(["--session-id", id], ["/exit"]);
  expect(Exit.isSuccess(exit)).toBe(true);
  expect(logged).toEqual(["No model to ask · /model to pick one, /help for commands, /exit to quit.", "ERROR: No model is set.\nHINT: Pick one with /model."]);
  expect(existsSync(sessionFolderOf(storeFolder, id))).toBe(false);
});

test("at a terminal, a model whose provider has no key set opens the REPL without a model, saying what to do in the REPL", async () => {
  const { logged } = await atTerminal(["--model", "grok-4.7"], ["/exit"]);
  expect(logged[1]).toBe("ERROR: XAI_API_KEY is not set, so xai models cannot be asked.\nHINT: Pick another model with /model, or restart with XAI_API_KEY set.");
});

test("print mode at a terminal with no model is refused at once, in the command line's words", async () => {
  const { exit, logged, errors } = await atTerminal(["-p", "Hello"], []);
  expect(Exit.isFailure(exit)).toBe(true);
  expect(logged).toEqual([]);
  expect(errors).toEqual(["ERROR: --model is required.\nHINT: bun cli models shows available models discovered from the environment."]);
});
