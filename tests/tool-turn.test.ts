import { afterAll, expect, test } from "bun:test";
import { json } from "./support/received.ts";
import { Effect, Layer } from "effect";
import type { Observation } from "../src/agent-core/observation.ts";
import { BoringModelProvider, CountingTurns } from "../src/agent-effect/boring.ts";
import { HttpModelClient } from "../src/agent-effect/http-model-client.ts";
import { openSession } from "../src/agent-effect/loop.ts";
import { SmolToolRunner, smolCatalog } from "../src/agent-effect/smol-tools.ts";
import { ToolContextAssembler } from "../src/agent-effect/tool-context.ts";

/** A provider that calls `add` on the first request and answers with the result on the second. */
const received: Array<unknown> = [];
const responses = [
  {
    id: "msg_1",
    content: [
      { type: "text", text: "I'll add them." },
      { type: "tool_use", id: "toolu_1", name: "add", input: { a: 2, b: 3 } },
    ],
    stop_reason: "tool_use",
  },
  { id: "msg_2", content: [{ type: "text", text: "2 + 3 = 5." }], stop_reason: "end_turn" },
];
const provider = Bun.serve({
  port: 0,
  async fetch(request) {
    received.push(await request.json());
    return Response.json(responses[received.length - 1] ?? { error: "no more scripted responses" }, {
      status: received.length <= responses.length ? 200 : 500,
    });
  },
});
afterAll(() => provider.stop(true));

const services = Layer.mergeAll(
  BoringModelProvider(new URL("/v1/messages", provider.url)),
  ToolContextAssembler(smolCatalog),
  HttpModelClient,
  CountingTurns,
  SmolToolRunner,
);

test("the model calls a tool from the catalog, and answers from its result", async () => {
  const facts = await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe({ _tag: "SessionOpened", session: "s1" } as unknown as Observation);
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "What is 2 + 3?" } as unknown as Observation);
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
    "ToolEnded",
    "ModelAsked",
    "ModelResponded",
    "TurnEnded",
  ]);
  expect(facts[6] as unknown).toMatchObject({
    observation: { call: "toolu_1", outcome: { _tag: "Succeeded", output: json(5) } },
  });

  const tools = [
    {
      name: "add",
      description: "Adds two numbers.",
      input_schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    },
    {
      name: "echo",
      description: "Returns the text it is given.",
      input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  ];
  const question = { role: "user", content: [{ type: "text", text: "What is 2 + 3?" }] };
  expect(received).toEqual([
    { model: "boring-1", max_tokens: 1024, tools, messages: [question] },
    {
      model: "boring-1",
      max_tokens: 1024,
      tools,
      messages: [
        question,
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll add them." },
            { type: "tool_use", id: "toolu_1", name: "add", input: { a: 2, b: 3 } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "5" }] },
      ],
    },
  ]);
});
