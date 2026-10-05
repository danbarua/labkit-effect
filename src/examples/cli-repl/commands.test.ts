/** The REPL's own commands, run against a session whose model client records what it is asked. */

import { expect } from "bun:test";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Brand, defaultBrand } from "../../agent-host/brand.ts";
import { KeyedAndLocalCatalog } from "../../agent-host/catalog.ts";
import { BoringContextAssembler } from "../../../tests/support/boring.ts";
import { runTest } from "../../../tests/support/run.ts";
import { test, testFolder } from "../../../tests/support/test.ts";
import { ModelName, ModelText, ProviderName, SessionId } from "../../agent-machine/names.ts";
import { ModelClient, type Target, ToolRunner } from "../../agent-session/contracts.ts";
import { openSession } from "../../agent-session/loop.ts";
import { EphemeralSessionStore } from "../../agent-session/session-store.ts";
import { ModelFromFacts } from "../../agent-session/configuration/model-choice.ts";
import { receivedJson } from "../../agent-session/received.ts";
import { openedWith } from "../../agent-session/configuration/session-setup.ts";
import { CountingTurns } from "../../agent-session/turns.ts";
import { command, completions, inForce, offered } from "./commands.ts";
import { ask } from "./session.ts";

/**
 * Runs `lines` in order (a command, or input to the model), as `brand` (the default when left out),
 * and returns what each command printed and what the model was asked with.
 */
const session = (lines: ReadonlyArray<string>, brand: Brand = defaultBrand, settings: Readonly<Record<string, unknown>> = { effort: "low" }, after: ReadonlyArray<unknown> = []) => {
  const asked: Array<Target> = [];
  const recording = Layer.succeed(ModelClient, {
    respond: (target, _context, turn) =>
      Effect.sync(() => {
        asked.push(target);
        return {
          _tag: "ModelResponded" as const,
          turn,
          provider: target.provider,
          model: target.model,
          parts: [{ _tag: "Text" as const, text: ModelText.make("ok") }],
          ending: { _tag: "Complete" as const },
          metadata: receivedJson({}),
        };
      }),
  });
  // A provider's key decides whether it can be asked; these are set for the commands to see.
  process.env["OPENAI_API_KEY"] = "set";
  process.env["ANTHROPIC_API_KEY"] = "set";
  delete process.env["XAI_API_KEY"];
  return runTest(
    Effect.gen(function* () {
      const opened = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* opened.observe(
        openedWith({ session: SessionId.make("s1"), model: { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5"), settings }, system: undefined, tools: [] } as Parameters<typeof openedWith>[0]),
      );
      for (const observation of after) yield* opened.observe(observation as Parameters<typeof opened.observe>[0]);
      const printed: Array<string | undefined> = [];
      for (const line of lines) {
        // `/settings` alone asks at the terminal which setting to change; here it stands for what it shows first.
        if (line === "/settings") printed.push(yield* inForce(opened));
        else if (line === "(offered)") printed.push(JSON.stringify(yield* offered(opened)));
        else if (line.startsWith("/")) printed.push(yield* command(opened, line, testFolder()).pipe(Effect.catchTag("UserError", (error) => Effect.succeed(`error: ${String(error.userMessage)}`))));
        else yield* ask(opened, line);
      }
      return { printed, asked };
    }).pipe(
      // No command here prompts; the terminal is there because `/model` and `/settings` alone would.
      Effect.orDie,
      Effect.provideService(Brand, brand),
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          KeyedAndLocalCatalog,
          ModelFromFacts,
          BoringContextAssembler,
          recording,
          CountingTurns,
          Layer.succeed(ToolRunner, { run: () => Effect.die("no tools") }),
        ),
      ),
    ),
  );
};

test("/model asks another model from the next turn on, and the settings said stay", async () => {
  const { printed, asked } = await session(["hello", "/model claude-sonnet-5-5", "hello again"]);
  expect(printed).toEqual(["Asking anthropic/claude-sonnet-5-5 effort=low"]);
  expect(asked.map((target) => [target.provider, target.model, target.settings?.effort]) as unknown).toEqual([
    ["openai", "gpt-5.5", "low"],
    ["anthropic", "claude-sonnet-5-5", "low"],
  ]);
});

test("/settings shows the settings in force, and changes the ones named", async () => {
  const { printed, asked } = await session(["/settings", "/settings effort=high maxOutputTokens=2000", "/settings", "hello"]);
  expect(printed).toEqual([
    "openai/gpt-5.5 effort=low\nthis model takes effort: none, low, medium, high, xhigh",
    "Asking openai/gpt-5.5 effort=high maxOutputTokens=2000\nthis model takes effort: none, low, medium, high, xhigh",
    "openai/gpt-5.5 effort=high maxOutputTokens=2000\nthis model takes effort: none, low, medium, high, xhigh",
  ]);
  expect(asked[0]?.settings as unknown).toEqual({ effort: "high", maxOutputTokens: 2000 });
});

test("/export writes the session's transcript as Markdown to .labkit/exports/<session>.md in the folder the CLI runs in", async () => {
  const { printed } = await session(["hello", "/export"]);
  const path = join(testFolder(), ".labkit", "exports", "s1.md");
  expect(printed).toEqual([`Exported this session to ${path}`]);
  const written = await Bun.file(path).text();
  expect(written).toContain("# Session `s1`");
  expect(written).toContain("hello");
});

test("/export writes to the brand's folder: .acme/exports for acme's", async () => {
  const { printed } = await session(["hello", "/export"], { name: "acme", version: "1.0.0" });
  const path = join(testFolder(), ".acme", "exports", "s1.md");
  expect(printed).toEqual([`Exported this session to ${path}`]);
  expect(await Bun.file(path).exists()).toBe(true);
});

test("/tools shows the tools the session opened with: here, none", async () => {
  const { printed } = await session(["/tools"]);
  expect(printed).toEqual(["No tools: the model is offered none."]);
});

test("a mistake in a command is said and changes nothing; a line that names no command is not one", async () => {
  const { printed } = await session(["/settings effort=loud", "/settings volume=11", "/model gpt-99", "/model grok-4.7", "/nope", "/settings"]);
  expect(printed[0]).toStartWith("error: Not settings the session takes:");
  expect(printed[1]).toStartWith("error: Not settings the session takes:");
  expect(printed.slice(2)).toEqual([
    "error: No model named gpt-99. `bun cli models` lists the models you can use; name one as it lists it, or as provider/model (for example openai/gpt-5.5, or localhost/<a model the local server serves>).",
    "error: Set XAI_API_KEY before calling xai/* models, or try a different model with --model provider/model.",
    undefined,
    "openai/gpt-5.5 effort=low\nthis model takes effort: none, low, medium, high, xhigh",
  ]);
});

test("a line that starts with / completes to a command, a model, a setting not yet named, and a value the model takes", async () => {
  const { printed } = await session(["(offered)", "/model grok-4.7", "/model claude-sonnet-5-5", "(offered)"]);
  const complete = completions(JSON.parse(printed[0] ?? "") as Parameters<typeof completions>[0]);
  expect(complete("/")).toEqual(["/model ", "/settings ", "/tools", "/export", "/mcp ", "/help", "/exit", "/quit"]);
  expect(complete("/se")).toEqual(["/settings "]);
  expect(complete("/model openai/gpt-6-s")).toEqual(["/model openai/gpt-6-sol"]);
  expect(complete("/model xai/")).toEqual([]);
  expect(complete("/settings ")).toEqual(["effort=", "thinking=", "observe=", "cache=", "maxOutputTokens="].map((each) => `/settings ${each}`));
  expect(complete("/settings effort=high c")).toEqual(["/settings effort=high cache="]);
  expect(complete("/settings effort=high e")).toEqual([]);
  // gpt-5.5 takes none to xhigh: no max, and thinking can be off.
  expect(complete("/settings effort=")).toEqual(["low", "medium", "high", "xhigh"].map((each) => `/settings effort=${each}`));
  expect(complete("/settings thinking=o")).toEqual(["/settings thinking=off"]);
  expect(complete("hello /se")).toEqual([]);
  // OpenAI caches for minutes whatever is asked, so `off` is not offered.
  expect(complete("/settings cache=")).toEqual(["/settings cache=5m", "/settings cache=1h"]);
  // The values follow the model being asked: no efforts are listed for claude-sonnet-5-5, so every one is offered.
  const later = completions(JSON.parse(printed[3] ?? "") as Parameters<typeof completions>[0]);
  expect(later("/settings effort=m")).toEqual(["/settings effort=medium", "/settings effort=max"]);
  expect(later("/settings cache=")).toEqual(["off", "5m", "1h"].map((each) => `/settings cache=${each}`));
});

test("/mcp says how the MCP servers are, and completes to reconnect and then a server's name", async () => {
  const { printed } = await session(["/mcp"]);
  expect(printed).toEqual(["This session has no MCP servers."]);
  const complete = completions({ models: [], settings: [], servers: ["github", "files"] });
  expect(complete("/mcp ")).toEqual(["/mcp reconnect "]);
  expect(complete("/mcp reconnect ")).toEqual(["/mcp reconnect github", "/mcp reconnect files"]);
  expect(complete("/mcp reconnect g")).toEqual(["/mcp reconnect github"]);
});

test("/settings with no settings said says so; with none sent but some not sent to this model, it names those", async () => {
  const none = await session(["/settings"], defaultBrand, {});
  expect(none.printed[0]).toStartWith("openai/gpt-5.5 (no settings said)");
  const adjusted = {
    _tag: "SettingAdjusted",
    provider: "openai",
    model: "gpt-5.5",
    adjusted: { _tag: "Cache", asked: "1h" },
    reason: "the adapter does not send this setting",
  };
  const notSent = await session(["/settings"], defaultBrand, {}, [adjusted]);
  expect(notSent.printed[0]).toStartWith("openai/gpt-5.5\nnot sent to this model: cache=1h");
});

test("/mcp completes a server's name only after reconnect", () => {
  const complete = completions({ models: [], settings: [], servers: ["github", "files"] });
  expect(complete("/mcp other ")).toEqual([]);
});
