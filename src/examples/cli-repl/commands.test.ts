/** The REPL's own commands, run against a session whose model client records what it is asked. */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Ref } from "effect";
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
import { completions, offered, runInSession } from "./commands.ts";
import { inForce } from "./model-settings.ts";
import type { LayerSource } from "../../agent-config/file.ts";
import { said } from "./command.ts";
import { viewOf } from "./view.ts";
import { ask } from "./session.ts";

/** The user's configuration folder of the test: the commands write the user's settings into it. */
const configFolder = () => join(testFolder(), "config");

/**
 * Runs `lines` in order (a command, or input to the model), as `brand` (the default when left out),
 * with the session's configuration read from `layers`, and returns what each command printed, what
 * the model was asked with, and whether the REPL shows thinking at the end.
 */
const session = (
  lines: ReadonlyArray<string>,
  brand: Brand = defaultBrand,
  settings: Readonly<Record<string, unknown>> = { effort: "low" },
  after: ReadonlyArray<unknown> = [],
  layers: ReadonlyArray<LayerSource> = [],
) => {
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
      const view = yield* viewOf("on");
      const context = { folder: testFolder(), configFolder: configFolder(), view, layers, commandLine: {} };
      const printed: Array<string | undefined> = [];
      for (const line of lines) {
        // `/settings` alone asks at the terminal which setting to change; here it stands for what it shows first.
        if (line === "/settings") printed.push(yield* inForce(opened));
        else if (line === "(offered)") printed.push(JSON.stringify(yield* offered(opened)));
        else if (line.startsWith("/")) {
          const done = yield* runInSession(opened, line, context).pipe(Effect.catchTag("UserError", (error) => Effect.succeed(said(String(error.userMessage)))));
          printed.push(done._tag === "Said" ? done.text : `(${done._tag})`);
        }
        else yield* ask(opened, line);
      }
      return { printed, asked, thinking: yield* Ref.get(view.thinking) };
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

test("/switch asks another model from the next turn on, in this session only, and the settings said stay", async () => {
  const { printed, asked } = await session(["hello", "/switch claude-sonnet-5-5", "hello again"]);
  expect(printed).toEqual(["anthropic/claude-sonnet-5-5 · effort=low\nEfforts: low, medium, high, xhigh, max"]);
  expect(existsSync(configFolder())).toBe(false);
  expect(asked.map((target) => [target.provider, target.model, target.settings?.effort]) as unknown).toEqual([
    ["openai", "gpt-5.5", "low"],
    ["anthropic", "claude-sonnet-5-5", "low"],
  ]);
});

test("/settings shows the settings in force, and changes the ones named", async () => {
  const { printed, asked } = await session(["/settings", "/settings effort=high maxOutputTokens=2000", "/settings", "hello"]);
  expect(printed).toEqual([
    "openai/gpt-5.5 · effort=low\nEfforts: low, medium, high, xhigh",
    "openai/gpt-5.5 · effort=high maxOutputTokens=2000\nEfforts: low, medium, high, xhigh",
    "openai/gpt-5.5 · effort=high maxOutputTokens=2000\nEfforts: low, medium, high, xhigh",
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
  expect(printed).toEqual(["This session has no tools."]);
});

test("a mistake in a command is said and changes nothing; a line that names no command is not one", async () => {
  const { printed } = await session(["/settings effort=loud", "/settings volume=11", "/model gpt-99", "/model grok-4.7", "/nope", "/settings"]);
  expect(printed[0]).toBe("ERROR: Invalid value for effort: loud.\nHINT: Use one of: default, minimal, low, medium, high, xhigh, max.");
  expect(printed[1]).toBe("ERROR: Unknown setting: volume.\nHINT: The settings are effort, thinking, observe, cache, maxOutputTokens, view.thinking.");
  expect(printed.slice(2)).toEqual([
    "ERROR: Unknown model: gpt-99.\nHINT: Pick one with /model.",
    "ERROR: xai models are unavailable: XAI_API_KEY is not set.\nHINT: Pick another model with /model, or set XAI_API_KEY and restart.",
    "ERROR: Unknown command: /nope.\nHINT: Type /help to list the commands.",
    "openai/gpt-5.5 · effort=low\nEfforts: low, medium, high, xhigh",
  ]);
});

test("a line that starts with / completes to a command, a model, a setting not yet named, and a value the model takes", async () => {
  const { printed } = await session(["(offered)", "/model grok-4.7", "/model claude-sonnet-5-5", "(offered)"]);
  const complete = completions(JSON.parse(printed[0] ?? "") as Parameters<typeof completions>[0]);
  expect(complete("/")).toEqual(["/model ", "/switch ", "/effort ", "/settings ", "/tools", "/export", "/mcp ", "/help", "/exit", "/quit"]);
  expect(complete("/se")).toEqual(["/settings "]);
  expect(complete("/model openai/gpt-6-s")).toEqual(["/model openai/gpt-6-sol"]);
  expect(complete("/model xai/")).toEqual([]);
  // The output limit is not offered: it defaults to the model's own. Typed, it is taken.
  expect(complete("/settings ")).toEqual(["effort=", "thinking=", "observe=", "cache=", "view.thinking="].map((each) => `/settings ${each}`));
  expect(complete("/settings view.thinking=")).toEqual(["/settings view.thinking=on", "/settings view.thinking=off"]);
  expect(complete("/effort ")).toEqual(["default", "low", "medium", "high", "xhigh"].map((each) => `/effort ${each}`));
  expect(complete("/switch openai/gpt-6-s")).toEqual(["/switch openai/gpt-6-sol"]);
  expect(complete("/settings effort=high c")).toEqual(["/settings effort=high cache="]);
  expect(complete("/settings effort=high e")).toEqual([]);
  // gpt-5.5 takes low to xhigh, no max, and can turn its thinking off (models.dev lists effort none for it).
  expect(complete("/settings effort=")).toEqual(["default", "low", "medium", "high", "xhigh"].map((each) => `/settings effort=${each}`));
  expect(complete("/settings thinking=")).toEqual(["/settings thinking=default", "/settings thinking=disabled"]);
  expect(complete("hello /se")).toEqual([]);
  // OpenAI caches for minutes whatever is asked, so `off` is not offered.
  expect(complete("/settings cache=")).toEqual(["/settings cache=default", "/settings cache=5m", "/settings cache=1h"]);
  // The values follow the model being asked: claude-sonnet-5-5 takes low to max, and thinks only between tool calls on request.
  const later = completions(JSON.parse(printed[3] ?? "") as Parameters<typeof completions>[0]);
  expect(later("/settings effort=m")).toEqual(["/settings effort=medium", "/settings effort=max"]);
  expect(later("/settings thinking=")).toEqual(["/settings thinking=default", "/settings thinking=between_tools"]);
  expect(later("/settings cache=")).toEqual(["default", "off", "5m", "1h"].map((each) => `/settings cache=${each}`));
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
  expect(none.printed[0]).toStartWith("openai/gpt-5.5 · default settings");
  const adjusted = {
    _tag: "SettingAdjusted",
    provider: "openai",
    model: "gpt-5.5",
    adjusted: { _tag: "Cache", asked: "1h" },
    reason: "the adapter does not send this setting",
  };
  const notSent = await session(["/settings"], defaultBrand, {}, [adjusted]);
  expect(notSent.printed[0]).toStartWith("openai/gpt-5.5\nNot sent to this model: cache=1h");
});

test("/mcp completes a server's name only after reconnect", () => {
  const complete = completions({ models: [], settings: [], servers: ["github", "files"] });
  expect(complete("/mcp other ")).toEqual([]);
});

test("/settings takes only what the model takes, refusing anything else with the values it takes; default returns a setting to the provider's default", async () => {
  const { printed, asked } = await session([
    "/settings effort=none",
    "/settings effort=max",
    "/settings thinking=between_tools",
    "/settings budget=2048",
    "/settings thinking=disabled",
    "/settings effort=default",
    "hello",
  ]);
  // A thinking budget is how a provider takes an effort, not a setting: the effort is.
  expect(printed[0]).toStartWith("ERROR: Invalid value for effort: none.");
  expect(printed[3]).toStartWith("ERROR: Unknown setting: budget.");
  expect(printed.slice(1, 3)).toEqual([
    "ERROR: openai/gpt-5.5 does not support effort=max.\nHINT: Supported: default, low, medium, high, xhigh.",
    "ERROR: openai/gpt-5.5 does not support thinking=between_tools.\nHINT: Supported: default, disabled.",
  ]);
  expect(asked.map((target) => target.settings) as unknown).toEqual([{ thinking: "disabled" }]);
});

test("/model asks another model in this session, and writes it into the user's folder as the model new sessions ask", async () => {
  const { printed, asked } = await session(["/model claude-sonnet-5-5", "hello"]);
  const file = join(configFolder(), "models.yml");
  expect(printed).toEqual([`anthropic/claude-sonnet-5-5 · effort=low\nEfforts: low, medium, high, xhigh, max\nDefault model: anthropic/claude-sonnet-5-5 (saved to ${file})`]);
  expect(asked.map((target) => `${target.provider}/${target.model}`)).toEqual(["anthropic/claude-sonnet-5-5"]);
  expect(readFileSync(file, "utf8")).toBe("model: anthropic/claude-sonnet-5-5\n");
});

test("/model says so when a layer read after the user's folder sets the model too", async () => {
  const user: LayerSource = { name: join(configFolder(), "models.yml"), trusted: true, value: { model: "openai/gpt-5.5" } };
  const project: LayerSource = { name: "/project/.labkit/models.yml", trusted: false, value: { model: "openai/gpt-5" } };
  const { printed } = await session(["/model claude-sonnet-5-5"], defaultBrand, { effort: "low" }, [], [user, project]);
  expect(printed[0]?.split("\n").at(-1)).toBe(`HINT: /project/.labkit/models.yml sets model: openai/gpt-5, which overrides this default where that file is read.`);
});

test("/model says so when the model new sessions ask could not be written, and the session asks the model all the same", async () => {
  // The folder is a file, so nothing can be written into it.
  mkdirSync(testFolder(), { recursive: true });
  writeFileSync(configFolder(), "");
  const { printed, asked } = await session(["/model claude-sonnet-5-5", "hello"]);
  expect(printed[0]?.split("\n").at(-1)).toStartWith("ERROR: Could not save anthropic/claude-sonnet-5-5 as the default model:");
  expect(asked[0]?.model as unknown).toBe("claude-sonnet-5-5");
});

test("/effort sets the effort; alone, it sets the next value offered, and after the last, default", async () => {
  // gpt-5.5 is offered default, then low, medium, high and xhigh; the session starts at low.
  const { asked } = await session(["/effort high", "hello", "/effort", "hello", "/effort", "hello", "/effort", "hello"]);
  expect(asked.map((target) => target.settings) as unknown).toEqual([{ effort: "high" }, { effort: "xhigh" }, undefined, { effort: "low" }]);
});

test("/effort refuses an effort the model does not take", async () => {
  const { printed } = await session(["/effort max"]);
  expect(printed).toEqual(["ERROR: openai/gpt-5.5 does not support effort=max.\nHINT: Supported: default, low, medium, high, xhigh."]);
});

test("/effort alone, with no effort in force, sets the first effort the model is offered", async () => {
  const { asked } = await session(["/effort", "hello"], defaultBrand, {});
  expect(asked[0]?.settings as unknown).toEqual({ effort: "low" });
});

test("/settings view.thinking=off hides the thinking at once, and writes it into the user's folder", async () => {
  const { printed, thinking } = await session(["/settings view.thinking=off"]);
  const file = join(configFolder(), "settings.yml");
  expect(printed).toEqual([`view.thinking=off (saved to ${file})`]);
  expect(thinking).toBe("off");
  expect(readFileSync(file, "utf8")).toBe("cli:\n  view:\n    thinking: off\n");
});

test("/settings with a mistake in any setting named changes none of them", async () => {
  const { printed, thinking, asked } = await session(["/settings view.thinking=off effort=loud", "/settings view.thinking=maybe effort=high", "/settings view.colour=red", "hello"]);
  expect(printed[0]).toStartWith("ERROR: Invalid value for effort: loud.");
  expect(printed[1]).toBe("ERROR: Invalid value for view.thinking: maybe.\nHINT: Use one of: on, off.");
  expect(printed[2]).toBe("ERROR: Unknown setting: view.colour.\nHINT: The settings are effort, thinking, observe, cache, maxOutputTokens, view.thinking.");
  expect(thinking).toBe("on");
  expect(existsSync(configFolder())).toBe(false);
  expect(asked[0]?.settings as unknown).toEqual({ effort: "low" });
});

test("/settings reads the settings named together: Sonnet 5.5 thinks only between tool calls at high effort or below", async () => {
  const { printed } = await session(["/switch claude-sonnet-5-5", "/settings thinking=between_tools effort=xhigh", "/settings thinking=between_tools effort=high"]);
  expect(printed[1]).toBe("ERROR: anthropic/claude-sonnet-5-5 does not support thinking=between_tools.\nHINT: thinking=between_tools cannot be combined with effort=xhigh.");
  expect(printed[2]).toStartWith("anthropic/claude-sonnet-5-5 · thinking=between_tools effort=high");
});

test("/settings names a setting the model has none of in one line", async () => {
  // gpt-5 lists no effort none, and has no between-tools thinking: it has no thinking setting.
  const { printed } = await session(["/switch gpt-5", "/settings thinking=disabled"]);
  expect(printed[1]).toBe("ERROR: openai/gpt-5 has no thinking setting.");
});
