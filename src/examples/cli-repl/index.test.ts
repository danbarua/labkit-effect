/**
 * The command-line agent, run as a process. These cover what needs no provider: the models list,
 * and what it says when there is nothing to ask. Asking a model is checked live (`bun cli -p`).
 */

import { expect } from "bun:test";
import { test } from "../../../tests/support/test.ts";
import { localCapabilities } from "./models.ts";

const invoke = async (args: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const child = Bun.spawn([process.execPath, "src/examples/cli-repl/index.ts", ...args], {
    cwd: new URL("../../../", import.meta.url).pathname,
    stdin: new Blob([""]),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env["PATH"] ?? "", NO_COLOR: "1", FORCE_COLOR: "0", ...env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
};

test("models lists each provider's models from models.json, and whether its key is set", async () => {
  const { stdout, code } = await invoke(["models"], { OPENAI_API_KEY: "set" });
  const lines = stdout.trim().split("\n");
  expect(code).toBe(0);
  expect(lines.map((line) => line.split(":")[0])).toEqual(["anthropic (no ANTHROPIC_API_KEY)", "openai (key set)", "xai (no XAI_API_KEY)"]);
  expect(lines[0]).toContain("claude-sonnet-5-5");
  expect(lines[2]).toContain("grok-4.7");
});

test("with no model there is nothing to ask: it says so and fails", async () => {
  const result = await invoke(["-p", "Hello"]);
  expect(result.code).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("No model: pass --model");
});

test("a model that is not in models.json and names no provider is refused by name", async () => {
  const result = await invoke(["-p", "Hello", "--model", "gpt-99"]);
  expect(result.code).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("No model gpt-99 in models.json; name it as provider/model.");
});

test("print mode with no prompt and nothing piped says there is no prompt", async () => {
  const result = await invoke(["-p", "--model", "gpt-5.5"], { OPENAI_API_KEY: "set" });
  expect(result.code).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("No prompt: pass one, or pipe it in.");
});

test("a model whose provider has no key set is not asked: it names the variable", async () => {
  const result = await invoke(["-p", "Hello", "--model", "gpt-5.5"]);
  expect(result.code).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("OPENAI_API_KEY is not set, so openai/gpt-5.5 cannot be asked.");
});

test("what the local server lists of a model is what is known of it: its context window, input and reasoning efforts", () => {
  const listed = {
    data: [{ id: "qwen3.5-9b-8bit", context_window: null, capabilities: ["text", "tools"] }],
    models: [
      {
        slug: "qwen3.5-9b-8bit",
        context_window: 262144,
        input_modalities: ["text"],
        default_reasoning_level: "none",
        supported_reasoning_levels: [{ effort: "none" }, { effort: "low" }, { effort: "medium" }, { effort: "high" }],
      },
      { slug: "bare" },
    ],
  };
  expect([...localCapabilities(listed)]).toEqual([
    ["qwen3.5-9b-8bit", { context: 262144, input: ["text"], efforts: ["none", "low", "medium", "high"], price: { input: 0, output: 0 } }],
    ["bare", { input: ["text"], price: { input: 0, output: 0 } }],
  ]);
  expect(localCapabilities("not a list").size).toBe(0);
});
