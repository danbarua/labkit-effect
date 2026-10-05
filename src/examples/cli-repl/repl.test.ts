/** What the REPL prints after a turn. */

import { expect } from "bun:test";
import { observe, open, opened } from "../../../tests/support/drive.ts";
import { json } from "../../../tests/support/received.ts";
import { test } from "../../../tests/support/test.ts";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Terminal as EffectTerminal } from "effect";
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
import { replyOf, repl, Terminal, withoutModel } from "./repl.ts";
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
  expect(replied("1, 2, 3", "CutShort")).toBe("1, 2, 3\n(cut short: the response reached its length limit)");
  expect(replied("1, 2, 3", "Interrupted")).toBe("1, 2, 3\n(interrupted)");
});

test("an answer printed as it arrived is not printed again: only how it was cut short, if it was", () => {
  expect(replied("1, 2, 3", "Complete", true)).toBeUndefined();
  expect(replied("1, 2, 3", "CutShort", true)).toBe("(cut short: the response reached its length limit)");
});

/** A model that responds with its thinking and its answer, streaming them first when `streams`; and the requests it was asked. */
const thinkingThenOk = (streams: boolean) => {
  const asked: Array<string> = [];
  const layer = Layer.succeed(ModelClient, {
    respond: (target, _context, turn) =>
      Effect.gen(function* () {
        asked.push(turn);
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

/**
 * The REPL, followed at a terminal, typed `lines` with `model`: what it wrote to stdout, and the
 * lines it logged after its banner. With `failFirstWrite`, the first write to stdout throws.
 */
const typedTo = async (model: ReturnType<typeof thinkingThenOk>, lines: ReadonlyArray<string>, failFirstWrite = false) => {
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
      yield* Terminal.follow(session);
      const config = { sessionId: "s1", target: { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5") } } as unknown as Config;
      yield* repl(session, config, undefined, true).pipe(Effect.provideService(EffectTerminal.Terminal, yield* typing(lines)));
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
  expect(logged).toEqual(["ERROR: No command /nope.\nHINT: /help lists them."]);
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
      yield* Terminal.follow(session);
      yield* Terminal.wentOn(session).pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.die(new Error("the REPL waited for a turn that had ended")) }));
      return yield* TestConsole.logLines;
    }).pipe(Effect.provide(services(thinkingThenOk(false)))),
  );
  expect(logged).toEqual([]);
});

/** A catalog of `sources`, so that what can be asked depends on neither the environment nor a local server. */
const catalogOf = (sources: ReadonlyArray<CatalogSource>) => Layer.succeed(ModelCatalog, { sources: Effect.succeed(sources) });

const openai: CatalogSource = { provider: ProviderName.make("openai"), models: [ModelName.make("gpt-5.5"), ModelName.make("gpt-5")] };
const notAnswering: CatalogSource = { provider: ProviderName.make("localhost"), models: undefined, at: "http://localhost:8000/v1" };
const noModel = new CannotAsk({ message: "No model is set.", hint: "Pick one with /model." });

/** The REPL before a model is picked, typed `lines`, with a catalog of `sources`: the model picked, and what it logged. */
const waited = (lines: ReadonlyArray<string>, first?: string, sources: ReadonlyArray<CatalogSource> = [openai]) =>
  runTest(
    Effect.gen(function* () {
      const picked = yield* withoutModel(noModel, first).pipe(Effect.provideService(EffectTerminal.Terminal, yield* typing(lines)));
      return { picked, logged: yield* TestConsole.logLines };
    }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, catalogOf(sources), TestConsole.layer))),
  );

const banner = "No model to ask · /model to pick one, /help for commands, /exit to quit.";

test("before a model is picked: input for the model is not sent, the other commands are refused, and /model naming a model that can be asked returns that model", async () => {
  const { picked, logged } = await waited(["hello", "/tools", "/nope", "/model grok-4.7", "/model gpt-99", "/model gpt-5.5", "never read"]);
  expect(picked as unknown).toEqual({ provider: "openai", model: "gpt-5.5" });
  expect(logged).toEqual([
    banner,
    "ERROR: No model is set.\nHINT: Pick one with /model.",
    "ERROR: Not sent. No model is set.\nHINT: Pick one with /model.",
    "ERROR: /tools works once a model is picked.\nHINT: Pick one with /model.",
    "ERROR: No command /nope.\nHINT: /help lists them.",
    "ERROR: XAI_API_KEY is not set, so xai models cannot be asked.\nHINT: Pick another model with /model, or restart with XAI_API_KEY set.",
    "ERROR: No model is named gpt-99.\nHINT: Pick one with /model.",
  ]);
});

test("before a model is picked: /model alone picks from the models that can be asked", async () => {
  // Enter on the pick takes the first model listed.
  const { picked } = await waited(["/model", ""]);
  expect(picked as unknown).toEqual({ provider: "openai", model: "gpt-5.5" });
});

test("before a model is picked: the prompt the command line gave is said to be not sent, and /exit returns no model", async () => {
  const { picked, logged } = await waited(["/exit"], "hello");
  expect(picked).toBeUndefined();
  expect(logged).toEqual([banner, "ERROR: Not sent. No model is set.\nHINT: Pick one with /model."]);
});

test("before a model is picked: /model alone, with no model that can be asked, says what would make one available", async () => {
  const { picked, logged } = await waited(["/model", "/exit"], undefined, [notAnswering]);
  expect(picked).toBeUndefined();
  expect(logged.slice(2)).toEqual([
    [
      "ERROR: No model can be asked.",
      "HINT: Set ANTHROPIC_API_KEY to use anthropic models.",
      "HINT: Set OPENAI_API_KEY to use openai models.",
      "HINT: Set XAI_API_KEY to use xai models.",
      "HINT: The local server at http://localhost:8000/v1 is not answering; start it to use localhost models.",
    ].join("\n"),
  ]);
});
