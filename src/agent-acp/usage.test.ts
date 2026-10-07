/** The session's context gauge as ACP's `usage_update`. */

import { expect } from "bun:test";
import { Effect } from "effect";
import { observe, open } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";
import { test } from "../../tests/support/test.ts";
import { KnownModels } from "../agent-session/configuration/well-known-models.ts";
import { usageUpdate } from "./usage.ts";

/** A session asking `model` of `provider` that had one response, with the usage given, and then `more`. */
const session = (provider: string, model: string, ...more: ReadonlyArray<unknown>) => {
  const driven = open();
  observe(driven, { _tag: "SessionOpened", session: "s1", model: { provider, model } });
  observe(driven, { _tag: "InputArrived", from: { _tag: "User" }, text: "hi" });
  observe(driven, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider,
    model,
    parts: [{ _tag: "Text", text: "Hello." }],
    ending: { _tag: "Complete" },
    usage: { input: 1000, output: 200, thinking: 50 },
    metadata: json({}),
  });
  for (const fact of more) observe(driven, fact);
  return driven.journal;
};

test("a well-known model: the visible tokens of the last exchange, the model's window, and the cost so far", async () => {
  expect(await Effect.runPromise(usageUpdate(session("openai", "gpt-5.5")))).toEqual({
    sessionUpdate: "usage_update",
    used: 1150,
    size: 1050000,
    cost: { amount: (1000 * 5 + 200 * 30) / 1_000_000, currency: "USD" },
  });
});

test("the window is the model's the session asks now, after a change of model was taken", async () => {
  const changed = session("openai", "gpt-5.5", { _tag: "ModelChangeArrived", provider: "anthropic", model: "claude-haiku-4-5" });
  expect((await Effect.runPromise(usageUpdate(changed)))?.size).toBe(200000);
});

test("a model nothing is known of has no gauge; one the host knows has its window, and no cost while no response was priced: its cost is not known, not nothing", async () => {
  const local = session("localhost", "qwen/qwen3-8b");
  expect(await Effect.runPromise(usageUpdate(local))).toBeUndefined();
  const known = Effect.provideService(usageUpdate(local), KnownModels, [() => Effect.succeed({ context: 32768, input: ["text"], price: { input: 0, output: 0 } })]);
  expect(await Effect.runPromise(known)).toStrictEqual({ sessionUpdate: "usage_update", used: 1150, size: 32768 });
});

test("once a response is priced the cost is the priced responses' total; a local model's response adds nothing", async () => {
  const mixed = session(
    "localhost",
    "qwen/qwen3-8b",
    { _tag: "ModelChangeArrived", provider: "openai", model: "gpt-5.5" },
    {
      _tag: "ModelResponded",
      turn: "turn-1",
      provider: "openai",
      model: "gpt-5.5",
      parts: [{ _tag: "Text", text: "Hello again." }],
      ending: { _tag: "Complete" },
      usage: { input: 2000, output: 100 },
      metadata: json({}),
    },
  );
  const update = await Effect.runPromise(usageUpdate(mixed));
  expect(update).toMatchObject({ sessionUpdate: "usage_update", used: 2100, size: 1050000, cost: { currency: "USD" } });
  expect(update?.cost?.amount).toBeCloseTo((2000 * 5 + 100 * 30) / 1_000_000, 12);
});
