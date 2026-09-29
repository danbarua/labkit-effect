/** The OpenAI Responses adapter: how the core's types are shaped into its wire format and back. */

import { afterAll, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import type { Observation } from "../src/agent-core/observation.ts";
import { BoringModelProvider, CountingTurns, NoTurnEndHooks } from "../src/agent-effect/boring.ts";
import { openSession } from "../src/agent-effect/loop.ts";
import { OpenAiModelClient } from "../src/agent-effect/openai-client.ts";
import { SmolToolRunner, smolCatalog } from "../src/agent-effect/smol-tools.ts";
import { ToolContextAssembler } from "../src/agent-effect/tool-context.ts";
import { openAiAt, recordingServer } from "./support/providers.ts";
import { json } from "./support/received.ts";

const stops: Array<() => unknown> = [];
afterAll(() => {
  for (const stop of stops) stop();
});

async function turn(responses: ReadonlyArray<unknown>) {
  const provider = recordingServer(responses);
  stops.push(provider.stop);
  const facts = await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe({ _tag: "SessionOpened", session: "s1" } as unknown as Observation);
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "What is 2 + 3?" } as unknown as Observation);
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          ToolContextAssembler(smolCatalog),
          OpenAiModelClient.pipe(Layer.provide(openAiAt(provider.url))),
          CountingTurns,
          NoTurnEndHooks,
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

test("a tool turn sends the catalog, then the call and its output, as Responses input items", async () => {
  const { provider, facts } = await turn([callsAdd, answers]);
  const tools = smolCatalog.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.input }));
  const question = { role: "user", content: [{ type: "input_text", text: "What is 2 + 3?" }] };
  expect(provider.paths).toEqual(["/responses", "/responses"]);
  expect(provider.headers[0]).toMatchObject({ authorization: "Bearer test-key" });
  expect(provider.bodies).toEqual([
    { model: "boring-1", tools, input: [question] },
    {
      model: "boring-1",
      tools,
      input: [
        question,
        { type: "function_call", call_id: "call_1", name: "add", arguments: '{"a":2,"b":3}' },
        { type: "function_call_output", call_id: "call_1", output: "5" },
      ],
    },
  ]);
  expect(facts.at(-1) as unknown).toMatchObject({ decision: { _tag: "TurnEnded", ending: { _tag: "Answered" } } });
});

test("output items become parts: text, calls to any tool name, and everything else kept whole", async () => {
  const { facts } = await turn([
    {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        { type: "reasoning", id: "rs_1", summary: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading." }, { type: "refusal", refusal: "no" }] },
        { type: "function_call", call_id: "call_9", name: "___read_", arguments: '{"path":"a.ts"}' },
      ],
    },
    answers,
  ]);
  const responded = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded");
  expect(responded as unknown).toMatchObject({
    observation: {
      stop: "incomplete: max_output_tokens",
      ending: { _tag: "CutShort" },
      parts: [
        { _tag: "Unrecognised", received: json({ type: "reasoning", id: "rs_1", summary: [] }) },
        { _tag: "Text", text: "Reading." },
        { _tag: "Unrecognised", received: json({ type: "refusal", refusal: "no" }) },
        { _tag: "ToolCall", call: "call_9", tool: "___read_", input: { body: { _tag: "Text", text: '{"path":"a.ts"}' } } },
      ],
    },
  });
  const ended = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ToolEnded");
  expect(ended as unknown).toMatchObject({ observation: { call: "call_9", outcome: { _tag: "Failed", reason: { _tag: "NotFound" } } } });
});
