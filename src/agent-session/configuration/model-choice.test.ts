/** The model a session asks, read from its facts. */

import { expect } from "bun:test";
import { Effect, Exit } from "effect";
import type { Fact } from "../../agent-machine/fact.ts";
import { TurnId } from "../../agent-machine/names.ts";
import { observe, open, opened } from "../../../tests/support/drive.ts";
import { test } from "../../../tests/support/test.ts";
import { ModelProvider } from "../contracts.ts";
import { ModelFromFacts } from "./model-choice.ts";

const toOpenAi = { _tag: "ModelChangeArrived", provider: "openai", model: "gpt-5.6" };

const select = (facts: ReadonlyArray<Fact>) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* (yield* ModelProvider).select(facts, TurnId.make("turn-1"));
    }).pipe(Effect.provide(ModelFromFacts)),
  );

test("a session's facts say which model it asks: the latest change taken, or the one it opened with", async () => {
  const session = open();
  observe(session, opened);
  expect(await select(session.journal) as unknown).toEqual(Exit.succeed({ provider: "boring", model: "boring-1" }));
  observe(session, toOpenAi);
  observe(session, { _tag: "ModelChangeArrived", provider: "openai", model: "gpt-5.6-mini" });
  // A session loaded from these facts asks the model it last switched to.
  expect(await select(session.journal) as unknown).toEqual(Exit.succeed({ provider: "openai", model: "gpt-5.6-mini" }));
});

test("asking for the model of a session that was never opened is a defect", async () => {
  const exit = await select([]);
  expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true);
});
