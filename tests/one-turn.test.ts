import { afterAll, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { BoringContextAssembler, BoringModelProvider, CountingTurns } from "../src/agent-effect/boring.ts";
import { HttpModelClient } from "../src/agent-effect/http-model-client.ts";
import { openSession } from "../src/agent-effect/loop.ts";
import type { Observation } from "../src/agent-core/observation.ts";

/** A provider that answers every request the same way, and keeps what it was sent. */
const received: Array<{ path: string; body: unknown }> = [];
const provider = Bun.serve({
  port: 0,
  async fetch(request) {
    received.push({ path: new URL(request.url).pathname, body: await request.json() });
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
  BoringModelProvider(new URL("/v1/messages", provider.url)),
  BoringContextAssembler,
  HttpModelClient,
  CountingTurns,
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
    "TurnRequested",
    "TurnStarted",
    "ModelAsked",
    "ModelResponded",
    "TurnEnded",
  ]);
  expect(received).toEqual([
    {
      path: "/v1/messages",
      body: { model: "boring-1", max_tokens: 1024, messages: [{ role: "user", content: "Hello" }] },
    },
  ]);
  expect(facts[5] as unknown).toMatchObject({
    observation: {
      turn: "turn-1",
      provider: "boring",
      model: "boring-1",
      parts: [{ _tag: "Text", text: "Hello back." }],
      stop: "end_turn",
      metadata: { id: "msg_1", usage: { input_tokens: 3, output_tokens: 3 } },
    },
  });
  expect(facts[6] as unknown).toMatchObject({ decision: { turn: "turn-1", ending: { _tag: "Answered" } } });
});
