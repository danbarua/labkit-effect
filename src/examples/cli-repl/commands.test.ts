/** The REPL's own commands, run against a session whose model client records what it is asked. */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { BoringContextAssembler } from "../../../tests/support/boring.ts";
import { runTest } from "../../../tests/support/run.ts";
import { test } from "../../../tests/support/test.ts";
import { ModelName, ModelText, ProviderName, SessionId } from "../../agent-machine/names.ts";
import { ModelClient, type Target, ToolRunner } from "../../agent-session/contracts.ts";
import { openSession } from "../../agent-session/loop.ts";
import { ModelFromFacts } from "../../agent-session/model-choice.ts";
import { receivedJson } from "../../agent-session/received.ts";
import { openedWith } from "../../agent-session/session-setup.ts";
import { CountingTurns, NoTurnEndHooks } from "../../agent-session/turns.ts";
import { command } from "./commands.ts";
import { ask } from "./session.ts";

/** Runs `lines` in order (a command, or input to the model) and returns what each command printed and what the model was asked with. */
const session = (lines: ReadonlyArray<string>) => {
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
      const opened = yield* openSession;
      yield* opened.observe(
        openedWith({ session: SessionId.make("s1"), model: { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5"), settings: { effort: "low" } }, system: undefined, tools: [] }),
      );
      const printed: Array<string | undefined> = [];
      for (const line of lines) {
        if (line.startsWith("/")) printed.push(yield* command(opened, line).pipe(Effect.catchTag("UserError", (error) => Effect.succeed(`error: ${String(error.userMessage)}`))));
        else yield* ask(opened, line);
      }
      return { printed, asked };
    }).pipe(
      // No command here prompts; the terminal is there because `/model` alone would.
      Effect.orDie,
      Effect.provide(
        Layer.mergeAll(BunServices.layer, ModelFromFacts, BoringContextAssembler, recording, CountingTurns, NoTurnEndHooks, Layer.succeed(ToolRunner, { run: () => Effect.die("no tools") })),
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

test("a mistake in a command is said and changes nothing; a line that names no command is not one", async () => {
  const { printed } = await session(["/settings effort=loud", "/settings volume=11", "/model gpt-99", "/model grok-4.7", "/nope", "/settings"]);
  expect(printed[0]).toStartWith("error: Not settings the session takes:");
  expect(printed[1]).toStartWith("error: Not settings the session takes:");
  expect(printed.slice(2)).toEqual([
    "error: No model gpt-99 in models.json; name it as provider/model.",
    "error: XAI_API_KEY is not set, so xai/grok-4.7 cannot be asked.",
    undefined,
    "openai/gpt-5.5 effort=low\nthis model takes effort: none, low, medium, high, xhigh",
  ]);
});
