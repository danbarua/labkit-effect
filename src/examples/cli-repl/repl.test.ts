/** What the REPL prints after a turn. */

import { expect } from "bun:test";
import { observe, open, opened } from "../../../tests/support/drive.ts";
import { json } from "../../../tests/support/received.ts";
import { test, testFolder } from "../../../tests/support/test.ts";
import { BunServices } from "@effect/platform-bun";
import { existsSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { Effect, Layer, Ref, Terminal as EffectTerminal } from "effect";
import { TestConsole } from "effect/testing";
import { type CatalogSource, KeyedAndLocalCatalog, ModelCatalog } from "../../agent-host/catalog.ts";
import { Millis, ModelName, ModelText, ProviderName, SessionId, ThinkingText } from "../../agent-machine/names.ts";
import { ModelClient, ToolRunner } from "../../agent-session/contracts.ts";
import { ModelFromFacts } from "../../agent-session/configuration/model-choice.ts";
import { openedWith } from "../../agent-session/configuration/session-setup.ts";
import { openSession } from "../../agent-session/loop.ts";
import { ModelStream, ModelStreamInterval } from "../../agent-session/model-stream.ts";
import { receivedJson } from "../../agent-session/received.ts";
import { EphemeralSessionStore } from "../../agent-session/session-store.ts";
import { CountingTurns } from "../../agent-session/turns.ts";
import { BoringContextAssembler } from "../../../tests/support/boring.ts";
import { runTest } from "../../../tests/support/run.ts";
import { typing } from "../../../tests/support/terminal.ts";
import { CannotAsk } from "./models.ts";
import { replyOf, repl, terminal, withoutModel } from "./repl.ts";
import { type View, viewOf } from "./view.ts";
import type { SettingsChange } from "../../agent-machine/settings.ts";
import { ask, type Config } from "./session.ts";

/** What is printed after a turn whose one response said `text` and ended `ending`; `printed`, whether it was printed as it arrived. */
const replied = (text: string, ending: string, printed = false) => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "count" });
  if (ending === "Interrupted") observe(session, { _tag: "TurnInterrupted", turn: "turn-1" });
  observe(session, { _tag: "ModelResponded", turn: "turn-1", provider: "boring", model: "boring-1", parts: [{ _tag: "Text", text }], ending: { _tag: ending }, metadata: json({}) });
  return replyOf(session.journal, () => printed);
};

test("an answer is printed after its turn; one cut short by its length limit, or interrupted, says so", () => {
  expect(replied("1, 2, 3", "Complete")).toBe("1, 2, 3");
  expect(replied("1, 2, 3", "CutShort")).toBe("1, 2, 3\n(stopped: the response reached a length limit)");
  expect(replied("1, 2, 3", "Interrupted")).toBe("1, 2, 3\n(interrupted)");
});

test("an answer printed as it arrived is not printed again: only how it was cut short, if it was", () => {
  expect(replied("1, 2, 3", "Complete", true)).toBeUndefined();
  expect(replied("1, 2, 3", "CutShort", true)).toBe("(stopped: the response reached a length limit)");
});

/**
 * A model that responds with its thinking and its answer, streaming them first when `streams`; and
 * the requests it was asked. `before` runs before it streams.
 */
const thinkingThenOk = (streams: boolean, before: Effect.Effect<void> = Effect.void) => {
  const asked: Array<string> = [];
  const layer = Layer.succeed(ModelClient, {
    respond: (target, _context, turn) =>
      Effect.gen(function* () {
        asked.push(turn);
        yield* before;
        const sink = yield* ModelStream;
        if (streams) {
          yield* sink({ _tag: "Delta", kind: "Thinking", text: "think" });
          yield* sink({ _tag: "Delta", kind: "Text", text: "ok" });
        }
        return {
          _tag: "ModelResponded" as const,
          turn,
          provider: target.provider,
          model: target.model,
          parts: [
            { _tag: "Thinking" as const, text: ThinkingText.make("think"), received: receivedJson({ thinking: "think" }) },
            { _tag: "Text" as const, text: ModelText.make("ok") },
          ],
          ending: { _tag: "Complete" as const },
          metadata: receivedJson({}),
        };
      }),
  });
  return { asked, layer };
};

/** The services the REPL tests run with: `model`, no tools, and a console the test reads. */
const services = (model: ReturnType<typeof thinkingThenOk>) =>
  Layer.mergeAll(
    BunServices.layer,
    KeyedAndLocalCatalog,
    ModelFromFacts,
    BoringContextAssembler,
    model.layer,
    CountingTurns,
    TestConsole.layer,
    Layer.succeed(ToolRunner, { run: () => Effect.die("no tools") }),
  );

const opening = openedWith({ session: SessionId.make("s1"), model: { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5") }, system: undefined, tools: [] });

/** The user's configuration folder of the test. */
const configFolder = () => join(testFolder(), "config");

/**
 * The REPL, followed at a terminal, typed `lines` with `model`, showing what `view` shows (thinking
 * shown when not given) and reading the keys of `stdin` while a turn runs: what it wrote to stdout,
 * and the lines it logged after its banner. With `failFirstWrite`, the first write to stdout throws.
 */
const typedTo = async (model: ReturnType<typeof thinkingThenOk>, lines: ReadonlyArray<string>, failFirstWrite = false, view?: View, stdin?: NodeJS.ReadStream) => {
  const written: Array<string> = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (failFirstWrite && written.length === 0) {
      written.push("");
      throw new Error("stdout is closed");
    }
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  const logged = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(opening);
      const shown = view ?? (yield* viewOf("on"));
      yield* terminal(shown, stdin).follow(session);
      const config = { sessionId: "s1", target: { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5") }, configuration: { layers: [] } } as unknown as Config;
      yield* repl(session, config, undefined, true, { configFolder: configFolder(), view: shown, commandLine: {} }).pipe(Effect.provideService(EffectTerminal.Terminal, yield* typing(lines)));
      return yield* TestConsole.logLines;
    }).pipe(Effect.provide(services(model)), Effect.provideService(ModelStreamInterval, Millis.make(0))),
  ).finally(() => {
    process.stdout.write = write;
  });
  return { written: written.join(""), logged: logged.slice(1) };
};

test("the REPL: Enter on an empty line asks nothing, a line naming no command says so, /exit ends it; a streamed answer is printed as it arrives, its thinking dimmed, and not again after its turn", async () => {
  const model = thinkingThenOk(true);
  const { written, logged } = await typedTo(model, ["hello", "", "/nope", "/exit"]);
  expect(model.asked).toHaveLength(1);
  expect(written).toBe("\x1b[2mthink\x1b[0m\nok\n");
  expect(logged).toEqual(["ERROR: Unknown command: /nope.\nHINT: Type /help to list the commands."]);
});

test("the REPL: an answer that did not stream is printed once, from the response, when it arrives", async () => {
  const { written, logged } = await typedTo(thinkingThenOk(false), ["hello", "/exit"]);
  expect(written).toBe("\x1b[2mthink\x1b[0m\nok\n");
  expect(logged).toEqual([]);
});

test("the REPL: a write to the terminal that fails is logged, and later turns are followed and answered", async () => {
  const model = thinkingThenOk(true);
  const { written } = await typedTo(model, ["hello", "again", "/exit"], true);
  expect(model.asked).toHaveLength(2);
  expect(written).toContain("ok");
});

test("the REPL: after going on with a turn that ended before it followed the session, it does not wait for that turn's end", async () => {
  const logged = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(opening);
      yield* ask(session, "hello");
      const host = terminal(yield* viewOf("on"));
      yield* host.follow(session);
      yield* host.wentOn(session).pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.die(new Error("the REPL waited for a turn that had ended")) }));
      return yield* TestConsole.logLines;
    }).pipe(Effect.provide(services(thinkingThenOk(false)))),
  );
  expect(logged).toEqual([]);
});

/** A catalog of `sources`, so that what can be asked depends on neither the environment nor a local server. */
const catalogOf = (sources: ReadonlyArray<CatalogSource>) => Layer.succeed(ModelCatalog, { sources: Effect.succeed(sources) });

const openai: CatalogSource = { provider: ProviderName.make("openai"), models: [ModelName.make("gpt-5.5"), ModelName.make("gpt-5")] };
const notAnswering: CatalogSource = { provider: ProviderName.make("localhost"), models: undefined, at: "http://localhost:8000/v1" };
const noModel = new CannotAsk({ message: "No model selected.", hint: "Pick one with /model." });

/**
 * The REPL before a model is picked, typed `lines`, with a catalog of `sources` and the settings the
 * command line names (`commandLine`): the model picked, what it logged, and whether it shows thinking
 * at the end.
 */
const waited = (lines: ReadonlyArray<string>, first?: string, sources: ReadonlyArray<CatalogSource> = [openai], commandLine: SettingsChange = {}) =>
  runTest(
    Effect.gen(function* () {
      const view = yield* viewOf("on");
      const picked = yield* withoutModel(noModel, first, { configFolder: configFolder(), view, commandLine }, []).pipe(Effect.provideService(EffectTerminal.Terminal, yield* typing(lines)));
      return { picked, logged: yield* TestConsole.logLines, thinking: yield* Ref.get(view.thinking) };
    }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, catalogOf(sources), TestConsole.layer))),
  );

const banner = "No model selected · /model to pick one · /help for commands · /exit to quit";

test("before a model is picked: input for the model is not sent, the other commands are refused, and /model naming a model that can be asked returns that model", async () => {
  const { picked, logged } = await waited(["hello", "/tools", "/nope", "/model grok-4.7", "/model gpt-99", "/model gpt-5.5", "never read"]);
  expect(picked as unknown).toEqual({ provider: "openai", model: "gpt-5.5" });
  expect(logged).toEqual([
    banner,
    "ERROR: No model selected.\nHINT: Pick one with /model.",
    "ERROR: Message not sent. No model selected.\nHINT: Pick one with /model.",
    "ERROR: /tools needs a model.\nHINT: Pick one with /model.",
    "ERROR: Unknown command: /nope.\nHINT: Type /help to list the commands.",
    "ERROR: xai models are unavailable: XAI_API_KEY is not set.\nHINT: Pick another model with /model, or set XAI_API_KEY and restart.",
    "ERROR: Unknown model: gpt-99.\nHINT: Pick one with /model.",
    `Default model: openai/gpt-5.5 (saved to ${join(configFolder(), "models.yml")})`,
  ]);
  expect(readFileSync(join(configFolder(), "models.yml"), "utf8")).toBe("model: openai/gpt-5.5\n");
});

test("before a model is picked: /model alone picks from the models that can be asked", async () => {
  // Enter on the pick takes the first model listed.
  const { picked } = await waited(["/model", ""]);
  expect(picked as unknown).toEqual({ provider: "openai", model: "gpt-5.5" });
});

test("before a model is picked: the prompt the command line gave is said to be not sent, and /exit returns no model", async () => {
  const { picked, logged } = await waited(["/exit"], "hello");
  expect(picked).toBeUndefined();
  expect(logged).toEqual([banner, "ERROR: Message not sent. No model selected.\nHINT: Pick one with /model."]);
});

test("before a model is picked: /model alone, with no model that can be asked, says what would make one available", async () => {
  const { picked, logged } = await waited(["/model", "/exit"], undefined, [notAnswering]);
  expect(picked).toBeUndefined();
  expect(logged.slice(2)).toEqual([
    [
      "ERROR: No models available.",
      "HINT: Set ANTHROPIC_API_KEY to use anthropic models.",
      "HINT: Set OPENAI_API_KEY to use openai models.",
      "HINT: Set XAI_API_KEY to use xai models.",
      "HINT: Start the local server at http://localhost:8000/v1 to use its models: it is not responding.",
    ].join("\n"),
  ]);
});

test("before a model is picked: /switch names the model the session opens with, and writes nothing", async () => {
  const { picked, logged } = await waited(["/switch gpt-5.5"]);
  expect(picked as unknown).toEqual({ provider: "openai", model: "gpt-5.5" });
  expect(logged).toHaveLength(2);
  expect(existsSync(configFolder())).toBe(false);
});

test("before a model is picked: /settings changes the user's settings, and refuses the model's", async () => {
  // `/settings` alone offers the user's settings to pick; Enter leaves them as they are, and shows them.
  const { logged, thinking } = await waited(["/settings effort=high", "/settings view.thinking=off", "/settings", "", "/exit"]);
  expect(logged.slice(2)).toEqual([
    "ERROR: effort=high needs a model.\nHINT: Pick one with /model.",
    `view.thinking=off (saved to ${join(configFolder(), "settings.yml")})`,
    "view.thinking=off",
  ]);
  expect(thinking).toBe("off");
});

test("the REPL: with thinking hidden, the answer is printed and its thinking is not", async () => {
  const { written } = await typedTo(thinkingThenOk(true), ["hello", "/exit"], false, await runTest(viewOf("off")));
  expect(written).toBe("ok\n");
});

test("the REPL: Option+T at the prompt hides the thinking, and is not typed", async () => {
  const model = thinkingThenOk(true);
  // macOS sends † for Option+T where Option is not set to send Meta.
  const { written } = await typedTo(model, ["†hello", "/exit"]);
  expect(written).toBe("ok\n");
  expect(model.asked).toHaveLength(1);
});

/** A terminal's input that is a terminal, for the keys the REPL reads itself while a turn runs. */
const keyboard = () =>
  Object.assign(new EventEmitter(), { isTTY: true, setRawMode: () => undefined, resume: () => undefined, pause: () => undefined }) as unknown as NodeJS.ReadStream;

test("the REPL: Option+T while a turn runs hides the thinking from then on, and says so", async () => {
  const stdin = keyboard();
  const view = await runTest(viewOf("on"));
  // Option+T is pressed as the model starts, which waits until the REPL has taken it.
  const pressed = Effect.sync(() => stdin.emit("data", Buffer.from("\x1bt"))).pipe(Effect.andThen(Effect.repeat(Effect.andThen(Effect.yieldNow, Ref.get(view.thinking)), { until: (now) => now === "off" })));
  const { written } = await typedTo(thinkingThenOk(true, Effect.asVoid(pressed)), ["hello", "/exit"], false, view, stdin);
  expect(written).not.toContain("think\x1b");
  expect(written).toContain("\x1b[2m(thinking hidden (Option+T shows it))\x1b[0m\n");
  expect(written).toContain("ok\n");
});

test("before a model is picked: a model that does not take the settings the command line names is not picked, and nothing is written; the REPL goes on", async () => {
  // gpt-5 takes minimal to high; gpt-5.5 takes low to xhigh.
  const { picked, logged } = await waited(["/model gpt-5", "/switch gpt-5", "/model gpt-5.5"], undefined, [openai], { effort: "xhigh" });
  const refused = "ERROR: openai/gpt-5 does not support effort=xhigh (from the command line).\nHINT: Supported: default, minimal, low, medium, high.\nHINT: Pick another model, or start the CLI again without that setting.";
  expect(logged.slice(2)).toEqual([refused, refused, `Default model: openai/gpt-5.5 (saved to ${join(configFolder(), "models.yml")})`]);
  expect(picked as unknown).toEqual({ provider: "openai", model: "gpt-5.5" });
});
