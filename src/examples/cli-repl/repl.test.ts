/** The REPL: what it prints, its keys, and the REPL without a model. */

import { defaultBrand } from "../../agent-host/brand.ts";
import { brandFoldersLayer, brandFoldersOf } from "../../agent-host/brand-folders.ts";
import { expect } from "bun:test";
import { observe, open, opened } from "../../../tests/support/drive.ts";
import { json } from "../../../tests/support/received.ts";
import { test, testFolder } from "../../../tests/support/test.ts";
import { BunServices } from "@effect/platform-bun";
import { existsSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { Effect, Layer, Ref, Terminal as EffectTerminal } from "effect";
import { BoringModelProvider, boringOpening } from "../../../tests/support/boring.ts";
import { smolCatalog, SmolToolRunner } from "../../../tests/support/smol-tools.ts";
import { permissions } from "../../agent-policy/permissions.ts";
import type { Policy } from "../../agent-policy/policy.ts";
import type { Observation } from "../../agent-machine/observation.ts";
import { TestConsole } from "effect/testing";
import { type CatalogSource, KeyedAndLocalCatalog, ModelCatalog } from "../../agent-host/catalog.ts";
import { CallId, Millis, ModelName, ModelText, ProviderName, SessionId, StopReason, ThinkingText, ToolName } from "../../agent-machine/names.ts";
import { ModelClient, ToolCallPolicies, ToolRunner } from "../../agent-session/contracts.ts";
import { ModelFromFacts } from "../../agent-session/configuration/model-choice.ts";
import { openedWith } from "../../agent-session/configuration/session-setup.ts";
import { openSession } from "../../agent-session/loop.ts";
import { ModelStream, ModelStreamInterval } from "../../agent-session/model-stream.ts";
import { receivedJson } from "../../agent-session/received.ts";
import { EphemeralSessionStore } from "../../agent-session/session-store.ts";
import { CountingTurns } from "../../agent-session/turns.ts";
import { BoringContextAssembler } from "../../../tests/support/boring.ts";
import { runTest } from "../../../tests/support/run.ts";
import { quitting, typing } from "../../../tests/support/terminal.ts";
import { CannotAsk } from "./models.ts";
import { replyOf, repl, terminal, withoutModel, shownEnded } from "./repl.ts";
import { type View, viewOf } from "./view.ts";
import type { SettingsChange } from "../../agent-machine/settings.ts";
import { ask, type Config } from "./session.ts";

/** Returns what is printed after a turn whose response was `text` and ended `ending`; `printed` says whether it already streamed. */
const replied = (text: string, ending: string, printed = false) => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "count" });
  if (ending === "Interrupted") observe(session, { _tag: "TurnInterrupted", turn: "turn-1" });
  observe(session, { _tag: "ModelResponded", turn: "turn-1", provider: "boring", model: "boring-1", parts: [{ _tag: "Text", text }], ending: { _tag: ending }, metadata: json({}) });
  return replyOf(session.journal, () => printed);
};


/** The brand's folders under the test's own folder. */
const testFolders = () => brandFoldersLayer(brandFoldersOf(defaultBrand, { home: testFolder() }));

test("after a turn the answer is printed, with a note when it was cut short or interrupted", () => {
  expect(replied("1, 2, 3", "Complete")).toBe("1, 2, 3");
  expect(replied("1, 2, 3", "CutShort")).toBe("1, 2, 3\n(stopped: the response reached a length limit)");
  expect(replied("1, 2, 3", "Interrupted")).toBe("1, 2, 3\n(interrupted)");
});

test("a streamed answer is not printed again after its turn; only the cut-short note is", () => {
  expect(replied("1, 2, 3", "Complete", true)).toBeUndefined();
  expect(replied("1, 2, 3", "CutShort", true)).toBe("(stopped: the response reached a length limit)");
});

/**
 * A model that responds with thinking and an answer, streaming them first when `streams`, and records
 * each request. `before` runs before it streams.
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
 * Runs the REPL at a terminal that types `lines`, with `model`, `view` (thinking shown by default),
 * and `stdin` for the keys during a turn. Returns what it wrote to stdout and the lines it logged
 * after its banner. With `failFirstWrite`, the first write to stdout throws.
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
    }).pipe(Effect.provide(Layer.merge(services(model), testFolders())), Effect.provideService(ModelStreamInterval, Millis.make(0))),
  ).finally(() => {
    process.stdout.write = write;
  });
  return { written: written.join(""), logged: logged.slice(1) };
};

test("the REPL ignores an empty line, reports an unknown command, prints a streamed answer once with its thinking dimmed, and ends on /exit", async () => {
  const model = thinkingThenOk(true);
  const { written, logged } = await typedTo(model, ["hello", "", "/nope", "/exit"]);
  expect(model.asked).toHaveLength(1);
  expect(written).toBe("\x1b[2mthink\x1b[0m\nok\n");
  expect(logged).toEqual(["ERROR: Unknown command: /nope.\nHINT: Type /help to list the commands."]);
});

test("the REPL prints an answer that did not stream once, when the response arrives", async () => {
  const { written, logged } = await typedTo(thinkingThenOk(false), ["hello", "/exit"]);
  expect(written).toBe("\x1b[2mthink\x1b[0m\nok\n");
  expect(logged).toEqual([]);
});

test("the REPL logs a failed terminal write and keeps answering later turns", async () => {
  const model = thinkingThenOk(true);
  const { written } = await typedTo(model, ["hello", "again", "/exit"], true);
  expect(model.asked).toHaveLength(2);
  expect(written).toContain("ok");
});

test("the REPL does not wait for the end of a resumed turn that had already ended", async () => {
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

/** A catalog of `sources`, so that the usable models depend on neither the environment nor a local server. */
const catalogOf = (sources: ReadonlyArray<CatalogSource>) => Layer.succeed(ModelCatalog, { sources: Effect.succeed(sources) });

const openai: CatalogSource = { provider: ProviderName.make("openai"), models: [ModelName.make("gpt-5.5"), ModelName.make("gpt-5")] };
const notAnswering: CatalogSource = { provider: ProviderName.make("localhost"), models: undefined, at: "http://localhost:8000/v1" };
const noModel = new CannotAsk({ message: "No model selected.", hint: "Pick one with /model." });

/**
 * Runs the REPL without a model, typed `lines`, with a catalog of `sources` and the command-line
 * settings `commandLine`. Returns the picked model, what it logged, and whether thinking is shown at
 * the end.
 */
const waited = (lines: ReadonlyArray<string>, first?: string, sources: ReadonlyArray<CatalogSource> = [openai], commandLine: SettingsChange = {}) =>
  runTest(
    Effect.gen(function* () {
      const view = yield* viewOf("on");
      const picked = yield* withoutModel(noModel, first, { configFolder: configFolder(), view, commandLine }, []).pipe(Effect.provideService(EffectTerminal.Terminal, yield* typing(lines)));
      return { picked, logged: yield* TestConsole.logLines, thinking: yield* Ref.get(view.thinking) };
    }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, catalogOf(sources), TestConsole.layer, testFolders()))),
  );

const banner = "No model selected · /model to pick one · /help for commands · /exit to quit";

test("without a model, the REPL sends no input, refuses commands that need a model, and picks a usable model named with /model", async () => {
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

test("without a model, /model with no name offers a picker of usable models", async () => {
  // Enter on the pick takes the first model listed.
  const { picked } = await waited(["/model", ""]);
  expect(picked as unknown).toEqual({ provider: "openai", model: "gpt-5.5" });
});

test("without a model, a prompt given on the command line is reported as not sent, and /exit picks no model", async () => {
  const { picked, logged } = await waited(["/exit"], "hello");
  expect(picked).toBeUndefined();
  expect(logged).toEqual([banner, "ERROR: Message not sent. No model selected.\nHINT: Pick one with /model."]);
});

test("without a model and with no usable models, /model explains how to make one available", async () => {
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

test("without a model, /switch picks the session's model and saves nothing", async () => {
  const { picked, logged } = await waited(["/switch gpt-5.5"]);
  expect(picked as unknown).toEqual({ provider: "openai", model: "gpt-5.5" });
  expect(logged).toHaveLength(2);
  expect(existsSync(configFolder())).toBe(false);
});

test("without a model, /settings changes the CLI's settings and rejects model settings", async () => {
  // `/settings` alone opens a picker of the CLI's settings; Enter leaves them unchanged and shows them.
  const { logged, thinking } = await waited(["/settings effort=high", "/settings view.thinking=off", "/settings", "", "/exit"]);
  expect(logged.slice(2)).toEqual([
    "ERROR: effort=high needs a model.\nHINT: Pick one with /model.",
    `view.thinking=off (saved to ${join(configFolder(), "settings.yml")})`,
    "view.thinking=off",
  ]);
  expect(thinking).toBe("off");
});

test("with thinking hidden, the REPL prints the answer without the thinking", async () => {
  const { written } = await typedTo(thinkingThenOk(true), ["hello", "/exit"], false, await runTest(viewOf("off")));
  expect(written).toBe("ok\n");
});

test("Option+T at the prompt hides thinking and inserts no character", async () => {
  const model = thinkingThenOk(true);
  // macOS sends † for Option+T where Option is not set to send Meta.
  const { written } = await typedTo(model, ["†hello", "/exit"]);
  expect(written).toBe("ok\n");
  expect(model.asked).toHaveLength(1);
});

/** A fake terminal input stream, for the keys the REPL reads itself during a turn. */
const keyboard = () =>
  Object.assign(new EventEmitter(), { isTTY: true, setRawMode: () => undefined, resume: () => undefined, pause: () => undefined }) as unknown as NodeJS.ReadStream;

test("Option+T during a turn hides the rest of the thinking and prints a note", async () => {
  const stdin = keyboard();
  const view = await runTest(viewOf("on"));
  // Option+T is pressed when the model starts, and the model waits until the REPL has toggled the view.
  const pressed = Effect.sync(() => stdin.emit("data", Buffer.from("\x1bt"))).pipe(Effect.andThen(Effect.repeat(Effect.andThen(Effect.yieldNow, Ref.get(view.thinking)), { until: (now) => now === "off" })));
  const { written } = await typedTo(thinkingThenOk(true, Effect.asVoid(pressed)), ["hello", "/exit"], false, view, stdin);
  expect(written).not.toContain("think\x1b");
  expect(written).toContain("\x1b[2m(thinking hidden (Option+T shows it))\x1b[0m\n");
  expect(written).toContain("ok\n");
});

test("without a model, a model that does not support the command-line settings is refused, nothing is saved, and the REPL keeps running", async () => {
  // gpt-5 supports minimal to high; gpt-5.5 supports low to xhigh.
  const { picked, logged } = await waited(["/model gpt-5", "/switch gpt-5", "/model gpt-5.5"], undefined, [openai], { effort: "xhigh" });
  const refused = "ERROR: openai/gpt-5 does not support effort=xhigh (from the command line).\nHINT: Supported: default, minimal, low, medium, high.\nHINT: Pick another model, or start the CLI again without that setting.";
  expect(logged.slice(2)).toEqual([refused, refused, `Default model: openai/gpt-5.5 (saved to ${join(configFolder(), "models.yml")})`]);
  expect(picked as unknown).toEqual({ provider: "openai", model: "gpt-5.5" });
});

test("an ended call that changed files is printed with each file's diff, from what it recorded: an update's patch, a created file's lines added", () => {
  const text = (value: string) => ({ mediaType: "text/plain", body: { _tag: "Text", text: value } }) as never;
  const printed = shownEnded("edit_file", '{"path":"a.txt"}', {
    _tag: "Succeeded",
    output: text("Edited /w/a.txt."),
    details: [
      { _tag: "FileChanged", path: "/w/a.txt" as never, change: "updated", patch: text("--- /w/a.txt\n+++ /w/a.txt\n@@ -1 +1 @@\n-alpha\n+beta") },
      { _tag: "FileChanged", path: "/w/new.txt" as never, change: "created", patch: text("hi\n") },
    ],
  });
  // Without its colours.
  expect(Bun.stripANSI(printed).split("\n")).toEqual([
    '● edit_file {"path":"a.txt"}',
    "  ⎿ Edited /w/a.txt.",
    "    --- /w/a.txt",
    "    +++ /w/a.txt",
    "    @@ -1 +1 @@",
    "    -alpha",
    "    +beta",
    "    --- /dev/null",
    "    +++ /w/new.txt",
    "    @@ -0,0 +1,1 @@",
    "    +hi",
  ]);
});

test("an ended call whose patch was cut is printed with the diff kept and how much was left out", () => {
  const text = (value: string) => ({ mediaType: "text/plain", body: { _tag: "Text", text: value } }) as never;
  const printed = shownEnded("write_file", '{"path":"big.txt"}', {
    _tag: "Succeeded",
    output: text("Wrote 40000 bytes to /w/big.txt."),
    details: [{ _tag: "FileChanged", path: "/w/big.txt" as never, change: "created", patch: text("one\n"), cut: 39996 as never }],
  });
  expect(Bun.stripANSI(printed).split("\n").slice(2)).toEqual([
    "    --- /dev/null",
    "    +++ /w/big.txt",
    "    @@ -0,0 +1,1 @@",
    "    +one",
    "    (The diff of /w/big.txt was cut at 32 KiB: 39996 more bytes are not shown.)",
  ]);
});

test("an ended call that moved a file is printed with one line for the move, not a diff", () => {
  const text = (value: string) => ({ mediaType: "text/plain", body: { _tag: "Text", text: value } }) as never;
  const printed = shownEnded("run_command", '{"command":"mv a.txt b.txt"}', { _tag: "Succeeded", output: text(""), details: [{ _tag: "FileMoved", from: "/w/a.txt" as never, to: "/w/b.txt" as never }] });
  expect(Bun.stripANSI(printed).split("\n").slice(2)).toEqual(["    Moved `/w/a.txt` to `/w/b.txt`."]);
});

/** A model that calls `echo` in its first response, and answers in any later one. */
const callsEcho = () => {
  let requests = 0;
  return Layer.succeed(ModelClient, {
    respond: (target, _context, turn) =>
      Effect.sync(() => ({
        _tag: "ModelResponded" as const,
        turn,
        provider: target.provider,
        model: target.model,
        parts: (requests += 1) > 1
          ? [{ _tag: "Text" as const, text: ModelText.make("done") }]
          : [{ _tag: "ToolCall" as const, call: CallId.make("c1"), tool: ToolName.make("echo"), input: receivedJson({ text: "hi" }) }],
        stop: StopReason.make("end_turn"),
        ending: { _tag: "Complete" as const },
        metadata: receivedJson({}),
      })),
  });
};

test("Ctrl+C at a permission question cancels the turn: no answer is recorded, the call does not run, and the turn ends interrupted", async () => {
  const { observed, decided } = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* terminal(yield* viewOf("on"), keyboard()).follow(session).pipe(Effect.provideService(EffectTerminal.Terminal, yield* quitting));
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "echo hi" } as unknown as Observation);
      yield* session.idle;
      const facts = yield* session.facts;
      return {
        observed: facts.flatMap((fact) => (fact._tag === "Observed" ? [fact.observation] : [])),
        decided: facts.flatMap((fact) => (fact._tag === "Decided" ? [fact.decision] : [])),
      };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          TestConsole.layer,
          BoringModelProvider,
          BoringContextAssembler,
          callsEcho(),
          SmolToolRunner,
          CountingTurns,
          Layer.succeed(ToolCallPolicies, [{ name: "permissions", policy: (facts) => Effect.succeed(permissions("default", true, () => "other", facts) as Policy<unknown>) }]),
        ),
      ),
    ),
  );
  const tags = observed.map((each) => each._tag);
  expect(tags).toContain("PermissionAsked");
  expect(tags).toContain("TurnInterrupted");
  expect(tags).not.toContain("PermissionAnswered");
  expect(tags).not.toContain("ToolCallDispatched");
  expect(observed.find((each) => each._tag === "ToolEnded")).toMatchObject({ call: "c1", outcome: { _tag: "Failed", reason: { _tag: "NotRun" } } });
  expect(decided.find((each) => each._tag === "TurnEnded")).toMatchObject({ ending: { _tag: "Interrupted" } });
});
