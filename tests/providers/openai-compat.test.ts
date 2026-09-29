/** The OpenAI-compatible Chat Completions adapter: how the core's types are shaped into its wire format and back. */

import { afterAll, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import type { Observation } from "../../src/agent-core/observation.ts";
import { BoringModelProvider, CountingTurns, NoTurnEndHooks } from "../../src/agent-effect/boring.ts";
import { openSession } from "../../src/agent-effect/loop.ts";
import { OpenAiCompatModelClient } from "../../src/agent-effect/openai-compat-client.ts";
import { SmolToolRunner, smolCatalog } from "../../src/agent-effect/smol-tools.ts";
import { ToolContextAssembler } from "../../src/agent-effect/tool-context.ts";
import { openAiCompatAt, recordingServer } from "../support/providers.ts";
import { json } from "../support/received.ts";

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
          OpenAiCompatModelClient.pipe(Layer.provide(openAiCompatAt(provider.url))),
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

const choice = (message: unknown, finish_reason: string) => ({ id: "chatcmpl-1", choices: [{ index: 0, message, finish_reason }] });
const callsAdd = choice(
  { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } }] },
  "tool_calls",
);
const answers = choice({ role: "assistant", content: "5." }, "stop");

test("a tool turn sends the catalog, then the call and a tool message with its result", async () => {
  const { provider, facts } = await turn([callsAdd, answers]);
  const tools = smolCatalog.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.input },
  }));
  const question = { role: "user", content: [{ type: "text", text: "What is 2 + 3?" }] };
  expect(provider.paths).toEqual(["/chat/completions", "/chat/completions"]);
  expect(provider.headers[0]).toMatchObject({ authorization: "Bearer test-key" });
  expect(provider.bodies).toEqual([
    { model: "boring-1", messages: [question], tools },
    {
      model: "boring-1",
      messages: [
        question,
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "5" },
      ],
      tools,
    },
  ]);
  expect(facts.at(-1) as unknown).toMatchObject({ decision: { _tag: "TurnEnded", ending: { _tag: "Answered" } } });
});

test("the choice's message becomes parts: content, calls to any tool name, and other fields kept whole", async () => {
  const { facts } = await turn([
    choice(
      {
        role: "assistant",
        content: "Reading.",
        reasoning_content: "The user wants a file.",
        tool_calls: [{ id: "call_9", type: "function", function: { name: "___read_", arguments: '{"path":"a.ts"}' } }],
      },
      "tool_calls",
    ),
    answers,
  ]);
  const responded = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded");
  expect(responded as unknown).toMatchObject({
    observation: {
      stop: "tool_calls",
      ending: { _tag: "Complete" },
      parts: [
        { _tag: "Text", text: "Reading." },
        { _tag: "Unrecognised", received: json({ reasoning_content: "The user wants a file." }) },
        { _tag: "ToolCall", call: "call_9", tool: "___read_" },
      ],
    },
  });
  const ended = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ToolEnded");
  expect(ended as unknown).toMatchObject({ observation: { call: "call_9", outcome: { _tag: "Failed", reason: { _tag: "NotFound" } } } });
});
