/**
 * The loop's context assembler: the system prompt the session opened with, and notices last, as one
 * instruction message after the conversation.
 */

import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { Notices } from "../../src/agent-context/assemble.ts";
import { AgentContextAssembler, WholeConversation } from "../../src/agent-context/assembler.ts";
import { SystemTimeNoticeProvider } from "../../src/agent-context/example-providers.ts";
import { TurnId } from "../../src/agent-core/names.ts";
import { ContextAssembler } from "../../src/agent-effect/contracts.ts";
import { observe, open, opened } from "../support/drive.ts";
import { runTest } from "../support/run.ts";

test("the notices are sent last, as an instruction after the latest input", async () => {
  const session = open();
  const system = { mediaType: "text/plain", body: { _tag: "Text", text: "You are a helpful assistant." } };
  observe(session, { ...opened, system });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "What day is it?" });
  const assembled = await runTest(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-29T12:00:00.000Z"));
      return yield* (yield* ContextAssembler).assemble(session.journal, TurnId.make("turn-1"));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          AgentContextAssembler.pipe(
            Layer.provide(
              Layer.mergeAll(WholeConversation, Layer.succeed(Notices, [SystemTimeNoticeProvider])),
            ),
          ),
          TestClock.layer(),
        ),
      ),
    ),
  );
  expect(assembled.system).toBe("You are a helpful assistant.");
  expect(assembled.messages).toEqual([
    { role: "user", parts: [{ _tag: "Text", text: "What day is it?" }] },
    { role: "instruction", parts: [{ _tag: "Text", text: "The current time is 2026-09-29T12:00:00.000Z." }] },
  ]);
});
