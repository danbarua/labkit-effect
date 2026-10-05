/** Print mode (`-p`): whether the process succeeds is decided by how the turn ended. */

import { expect } from "bun:test";
import { Effect, Layer } from "effect";
import { TestConsole } from "effect/testing";
import { ModelName, ModelText, ProviderName, SessionId, StopReason, ThinkingText } from "../../agent-machine/names.ts";
import { ModelClient, ToolRunner } from "../../agent-session/contracts.ts";
import { ModelFromFacts } from "../../agent-session/configuration/model-choice.ts";
import { openedWith } from "../../agent-session/configuration/session-setup.ts";
import { openSession } from "../../agent-session/loop.ts";
import { receivedJson } from "../../agent-session/received.ts";
import { EphemeralSessionStore } from "../../agent-session/session-store.ts";
import { CountingTurns } from "../../agent-session/turns.ts";
import { BoringContextAssembler } from "../../../tests/support/boring.ts";
import { runTest } from "../../../tests/support/run.ts";
import { test } from "../../../tests/support/test.ts";
import { printOnce } from "./print.ts";
import type { Config } from "./session.ts";

const target = { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5") };
const answer = { _tag: "Text" as const, text: ModelText.make("Done.") };
const thinking = { _tag: "Thinking" as const, text: ThinkingText.make("Hmm."), received: receivedJson({ thinking: "Hmm." }) };

/** Print mode with one prompt, whose one response holds `parts` and ends `ending`: whether the process failed, and the turn's ending. */
const printed = (parts: ReadonlyArray<typeof answer | typeof thinking>, ending: "Complete" | "CutShort") =>
  runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(openedWith({ session: SessionId.make("s1"), model: target, system: undefined, tools: [] }));
      const config = { sessionId: "s1", target } as unknown as Config;
      const result = yield* Effect.result(printOnce(session, config, "Go", "json", false));
      const lines = yield* TestConsole.logLines;
      return { failed: result._tag === "Failure", subtype: (JSON.parse(String(lines.at(-1))) as { readonly subtype: string }).subtype };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ModelFromFacts,
          BoringContextAssembler,
          CountingTurns,
          TestConsole.layer,
          Layer.succeed(ToolRunner, { run: () => Effect.die("no tools") }),
          Layer.succeed(ModelClient, {
            respond: (asked, _context, turn) =>
              Effect.succeed({
                _tag: "ModelResponded" as const,
                turn,
                provider: asked.provider,
                model: asked.model,
                parts,
                stop: StopReason.make("end_turn"),
                ending: { _tag: ending },
                metadata: receivedJson({}),
              }),
          }),
        ),
      ),
    ),
  );

test("print mode succeeds only when the turn ended Completed; an Incomplete or CutShort turn fails the process", async () => {
  expect(await printed([answer], "Complete")).toEqual({ failed: false, subtype: "Completed" });
  expect(await printed([thinking], "Complete")).toEqual({ failed: true, subtype: "Incomplete" });
  expect(await printed([answer], "CutShort")).toEqual({ failed: true, subtype: "CutShort" });
});
