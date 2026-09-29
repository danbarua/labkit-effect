import { afterAll, expect, test } from "bun:test";
import { anthropicAt } from "./support/providers.ts";
import { Effect, Layer } from "effect";
import { BoringContextAssembler, BoringModelProvider, CountingTurns } from "../src/agent-effect/boring.ts";
import { AnthropicModelClient } from "../src/agent-effect/anthropic-client.ts";
import { openSession } from "../src/agent-effect/loop.ts";
import { SmolToolRunner } from "../src/agent-effect/smol-tools.ts";
import type { Observation } from "../src/agent-core/observation.ts";

/** A provider that answers every request the same way. */

const provider = Bun.serve({
  port: 0,
  fetch() {
    return Response.json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "boring-1",
      content: [{ type: "text", text: "Hello back." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 3 },
    });
  },
});
afterAll(() => provider.stop(true));

const services = Layer.mergeAll(
  BoringModelProvider,
  AnthropicModelClient.pipe(Layer.provide(anthropicAt(provider.url))),
  BoringContextAssembler,
  CountingTurns,
  SmolToolRunner,
);

test("one turn, from the user's message to the model's answer", async () => {
  const facts = await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe({ _tag: "SessionOpened", session: "s1" } as unknown as Observation);
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "Hello" } as unknown as Observation);
      return yield* session.facts;
    }).pipe(Effect.provide(services)),
  );

  expect(facts.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag))).toEqual([
    "SessionOpened",
    "InputArrived",
    "TurnStarted",
    "InputDelivered",
    "ModelAsked",
    "ModelResponded",
    "TurnEnded",
  ]);
  expect(facts[5] as unknown).toMatchObject({
    observation: {
      turn: "turn-1",
      provider: "boring",
      model: "boring-1",
      parts: [{ _tag: "Text", text: "Hello back." }],
    },
  });
  expect(facts[6] as unknown).toMatchObject({ decision: { turn: "turn-1", ending: { _tag: "Answered" } } });
});
