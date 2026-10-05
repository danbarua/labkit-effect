/** What the REPL prints after a turn. */

import { expect } from "bun:test";
import { observe, open, opened } from "../../../tests/support/drive.ts";
import { json } from "../../../tests/support/received.ts";
import { test } from "../../../tests/support/test.ts";
import { BunServices } from "@effect/platform-bun";
import { type Cause, Effect, Layer, Option, Queue, Terminal as EffectTerminal } from "effect";
import { TestConsole } from "effect/testing";
import { KeyedAndLocalCatalog } from "../../agent-host/catalog.ts";
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
import { replyOf, repl, Terminal } from "./repl.ts";
import type { Config } from "./session.ts";

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

const key = (name: string, input?: string): EffectTerminal.UserInput => ({
  input: input === undefined ? Option.none() : Option.some(input),
  key: { name, ctrl: false, meta: false, shift: false },
});

/** A terminal that is typed `lines`, each ended with Enter, and shows nothing. */
const typing = (lines: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const keys = yield* Queue.unbounded<EffectTerminal.UserInput, Cause.Done>();
    yield* Queue.offerAll(
      keys,
      lines.flatMap((line) => [...line.split("").map((each) => key(each, each)), key("return", "\r")]),
    );
    return EffectTerminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      // Every prompt reads from the one queue: what one prompt leaves is the next one's.
      readInput: Effect.succeed(keys),
      readLine: Effect.fail(new EffectTerminal.QuitError()),
      display: () => Effect.void,
    });
  });

/** A model that streams its thinking and its answer, then responds with them; and the requests it was asked. */
const streaming = () => {
  const asked: Array<string> = [];
  const layer = Layer.succeed(ModelClient, {
    respond: (target, _context, turn) =>
      Effect.gen(function* () {
        asked.push(turn);
        const sink = yield* ModelStream;
        yield* sink({ _tag: "Delta", kind: "Thinking", text: "think" });
        yield* sink({ _tag: "Delta", kind: "Text", text: "ok" });
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

test("the REPL: Enter on an empty line asks nothing, a line naming no command says so, /exit ends it; a streamed answer is printed as it arrives, its thinking dimmed", async () => {
  const model = streaming();
  const written: Array<string> = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  const logged = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(
        openedWith({ session: SessionId.make("s1"), model: { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5") }, system: undefined, tools: [] }),
      );
      yield* Terminal.follow(session);
      const config = { sessionId: "s1", target: { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5") } } as unknown as Config;
      yield* repl(session, config, undefined, true).pipe(Effect.provideService(EffectTerminal.Terminal, yield* typing(["hello", "", "/nope", "/exit"])));
      return yield* TestConsole.logLines;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          KeyedAndLocalCatalog,
          ModelFromFacts,
          BoringContextAssembler,
          model.layer,
          CountingTurns,
          TestConsole.layer,
          Layer.succeed(ToolRunner, { run: () => Effect.die("no tools") }),
        ),
      ),
      Effect.provideService(ModelStreamInterval, Millis.make(0)),
    ),
  ).finally(() => {
    process.stdout.write = write;
  });
  expect(model.asked).toHaveLength(1);
  expect(written.join("")).toBe("\x1b[2mthink\x1b[0m\nok\n");
  // Whether the answer is printed again after its turn depends on whether the follower took the response's end first: not asserted.
  expect(logged.filter((line) => line !== "ok").slice(1)).toEqual(["No command /nope. /help lists them."]);
});
