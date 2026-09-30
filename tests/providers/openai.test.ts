/** The OpenAI Responses adapter: how the core's types are shaped into its wire format and back. */

import { afterAll, expect } from "bun:test";
import { test } from "../support/test.ts";
import { Effect, Layer } from "effect";
import type { Observation } from "../../src/agent-core/observation.ts";
import { BoringModelProvider } from "../support/boring.ts";
import { CountingTurns, NoTurnEndHooks } from "../../src/agent-effect/turns.ts";
import { openSession } from "../../src/agent-effect/loop.ts";
import { OpenAiModelClient } from "../../src/agent-effect/providers/openai-client.ts";
import { SmolToolRunner, smolCatalog } from "../support/smol-tools.ts";
import { TurnContextAssembler } from "../../src/agent-effect/turn-context.ts";
import { openAiAt, recordingServer } from "../support/providers.ts";
import { json } from "../support/received.ts";
import { runTest } from "../support/run.ts";
import { boringOpening } from "../support/boring.ts";

const stops: Array<() => unknown> = [];
afterAll(() => {
  for (const stop of stops) stop();
});

async function turn(responses: ReadonlyArray<unknown>) {
  const provider = recordingServer(responses);
  stops.push(provider.stop);
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.idle;
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "What is 2 + 3?" } as unknown as Observation);
      yield* session.idle;
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          TurnContextAssembler,
          OpenAiModelClient.pipe(Layer.provide(openAiAt(provider.url))),
          CountingTurns,
          NoTurnEndHooks,
          SmolToolRunner,
        ),
      ),
    ),
  );
  return { provider, facts };
}

const callsAdd = {
  id: "resp_1",
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_1", summary: [] },
    { type: "function_call", call_id: "call_1", name: "add", arguments: '{"a":2,"b":3}' },
  ],
};
const answers = { id: "resp_2", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "5." }] }] };

test("a tool turn sends the catalog, then the reasoning and call as received and the call's output, as Responses input items", async () => {
  const { provider, facts } = await turn([callsAdd, answers]);
  const tools = smolCatalog.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.input }));
  const question = { role: "user", content: [{ type: "input_text", text: "What is 2 + 3?" }] };
  expect(provider.paths).toEqual(["/responses", "/responses"]);
  expect(provider.headers[0]).toMatchObject({ authorization: "Bearer test-key" });
  expect(provider.bodies).toEqual([
    { model: "boring-1", stream: true, tools, input: [question] },
    {
      model: "boring-1",
      stream: true,
      tools,
      input: [
        question,
        { type: "reasoning", id: "rs_1", summary: [] },
        { type: "function_call", call_id: "call_1", name: "add", arguments: '{"a":2,"b":3}' },
        { type: "function_call_output", call_id: "call_1", output: "5" },
      ],
    },
  ]);
  expect(facts.at(-1) as unknown).toMatchObject({ decision: { _tag: "TurnEnded", ending: { _tag: "Answered" } } });
});

test("a commentary message is Commentary, and goes back as a message with that phase", async () => {
  const { provider, facts } = await turn([
    {
      status: "completed",
      output: [
        { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Adding them." }] },
        { type: "function_call", call_id: "call_1", name: "add", arguments: '{"a":2,"b":3}' },
      ],
    },
    { status: "completed", output: [{ type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "5." }] }] },
  ]);
  const responses = facts.flatMap((fact) =>
    fact._tag === "Observed" && fact.observation._tag === "ModelResponded" ? [fact.observation.parts.map((part) => part._tag)] : [],
  );
  expect(responses).toEqual([["Commentary", "ToolCall"], ["Text"]]);
  expect((provider.bodies[1] as { input: ReadonlyArray<unknown> }).input[1]).toEqual({
    role: "assistant",
    phase: "commentary",
    content: [{ type: "output_text", text: "Adding them." }],
  });
});

test("a reasoning item is Thinking: its summary as text to read, and the item to send back as it came", async () => {
  const reasoning = {
    type: "reasoning",
    id: "rs_1",
    encrypted_content: "opaque",
    summary: [
      { type: "summary_text", text: "**Adding**\n\nTwo numbers to add." },
      { type: "summary_text", text: "Use the tool." },
    ],
  };
  const { provider, facts } = await turn([
    { status: "completed", output: [reasoning, { type: "function_call", call_id: "call_1", name: "add", arguments: '{"a":2,"b":3}' }] },
    answers,
  ]);
  const responded = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded");
  expect(responded as unknown).toMatchObject({
    observation: {
      parts: [
        { _tag: "Thinking", text: "**Adding**\n\nTwo numbers to add.\n\nUse the tool.", received: json(reasoning) },
        { _tag: "ToolCall", call: "call_1" },
      ],
    },
  });
  expect((provider.bodies[1] as { input: ReadonlyArray<unknown> }).input[1]).toEqual(reasoning);
});

test("output items become parts: text, calls to any tool name, and everything else kept whole", async () => {
  const refused = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading." }, { type: "refusal", refusal: "no" }] };
  const { provider, facts } = await turn([
    {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        { type: "reasoning", id: "rs_1", summary: [] },
        refused,
        { type: "function_call", call_id: "call_9", name: "___read_", arguments: '{"path":"a.ts"}' },
      ],
    },
    answers,
  ]);
  expect((provider.bodies[1] as { input: ReadonlyArray<unknown> }).input.slice(1, 3)).toEqual([
    { type: "reasoning", id: "rs_1", summary: [] },
    refused,
  ]);
  const responded = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded");
  expect(responded as unknown).toMatchObject({
    observation: {
      stop: "incomplete: max_output_tokens",
      ending: { _tag: "CutShort" },
      parts: [
        { _tag: "Thinking", text: "", received: json({ type: "reasoning", id: "rs_1", summary: [] }) },
        { _tag: "Unrecognised", received: json(refused) },
        { _tag: "ToolCall", call: "call_9", tool: "___read_", input: { body: { _tag: "Text", text: '{"path":"a.ts"}' } } },
      ],
    },
  });
  const ended = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ToolEnded");
  expect(ended as unknown).toMatchObject({ observation: { call: "call_9", outcome: { _tag: "Failed", reason: { _tag: "NotFound" } } } });
});
