/** The OpenAI Responses adapter: how the core's types are shaped into its wire format and back. */

import { afterAll, expect } from "bun:test";
import { test } from "../../../tests/support/test.ts";
import { Effect, Layer } from "effect";
import { ModelName, ProviderName, TurnId } from "../../agent-machine/names.ts";
import type { Observation } from "../../agent-machine/observation.ts";
import { ModelClient, type ModelContext } from "../contracts.ts";
import { logKeys } from "../log-keys.ts";
import { asText } from "../received.ts";
import { BoringModelProvider } from "../../../tests/support/boring.ts";
import { CountingTurns } from "../turns.ts";
import { openSession } from "../loop.ts";
import { EphemeralSessionStore } from "../session-store.ts";
import { body, OpenAiModelClient } from "./openai-client.ts";
import { SmolToolRunner, smolCatalog } from "../../../tests/support/smol-tools.ts";
import { TurnContextAssembler } from "../turn-context.ts";
import { openAiAt, recordingServer } from "../../../tests/support/providers.ts";
import { json } from "../../../tests/support/received.ts";
import { runTest } from "../../../tests/support/run.ts";
import { boringOpening } from "../../../tests/support/boring.ts";

const stops: Array<() => unknown> = [];
afterAll(() => {
  for (const stop of stops) stop();
});

async function turn(responses: ReadonlyArray<unknown>) {
  const provider = recordingServer(responses);
  stops.push(provider.stop);
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
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
  expect(facts.at(-1) as unknown).toMatchObject({ decision: { _tag: "TurnEnded", ending: { _tag: "Completed" } } });
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

/** A Responses stream of one event. */
const streamOf = (event: Record<string, unknown>) => () =>
  new Response(`event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });

test.each([
  ["a response.failed rate_limit_exceeded", { type: "response.failed", response: { error: { code: "rate_limit_exceeded", message: "Slow down." } } }, "RateLimitError"],
  ["a response.failed server_error", { type: "response.failed", response: { error: { code: "server_error", message: "Oops." } } }, "InternalProviderError"],
  ["a response.failed of another code", { type: "response.failed", response: { error: { code: "invalid_prompt", message: "No." } } }, "UnknownError"],
  ["an error event rate_limit_exceeded", { type: "error", code: "rate_limit_exceeded", message: "Slow down." }, "RateLimitError"],
])("a failure the stream reports is the error its code stands for: %s", async (_, event, reason) => {
  const provider = recordingServer([streamOf(event)]);
  stops.push(provider.stop);
  const responded = await runTest(
    Effect.gen(function* () {
      const client = yield* ModelClient;
      return yield* client.respond(
        { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5") },
        { system: undefined, tools: [], messages: [{ role: "user", parts: [{ _tag: "Text", text: "Hello" }] }] },
        TurnId.make("turn-1"),
      );
    }).pipe(Effect.provide(OpenAiModelClient.pipe(Layer.provide(openAiAt(provider.url))))),
  );
  if (responded._tag !== "ModelFailed") throw new Error(`expected ModelFailed, got ${responded._tag}`);
  expect((JSON.parse(asText(responded.error)) as { readonly reason: { readonly _tag: string } }).reason._tag).toBe(reason);
});

test.each([
  ["a retry directive", "retry: 1000\n\n", "UnknownError", "The event stream asked to be retried"],
  ["an event larger than 10 MiB", `data: ${"x".repeat(10 * 1024 * 1024 + 1)}`, "InvalidOutputError", "The event stream could not be read"],
])("a stream that cannot be read as events fails the request: %s", async (_, body, reason, description) => {
  const provider = recordingServer([() => new Response(body, { headers: { "content-type": "text/event-stream" } })]);
  stops.push(provider.stop);
  const responded = await runTest(
    Effect.gen(function* () {
      const client = yield* ModelClient;
      return yield* client.respond(
        { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5") },
        { system: undefined, tools: [], messages: [{ role: "user", parts: [{ _tag: "Text", text: "Hello" }] }] },
        TurnId.make("turn-1"),
      );
    }).pipe(Effect.provide(OpenAiModelClient.pipe(Layer.provide(openAiAt(provider.url))))),
  );
  if (responded._tag !== "ModelFailed") throw new Error(`expected ModelFailed, got ${responded._tag}`);
  const error = JSON.parse(asText(responded.error)) as { readonly reason: { readonly _tag: string; readonly description?: string } };
  expect(error.reason._tag).toBe(reason);
  expect(error.reason.description).toStartWith(description);
});

test("a 2xx response with no body to read fails the request as an unknown error", async () => {
  const provider = recordingServer([() => new Response(null, { status: 204 })]);
  stops.push(provider.stop);
  const responded = await runTest(
    Effect.gen(function* () {
      const client = yield* ModelClient;
      return yield* client.respond(
        { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5") },
        { system: undefined, tools: [], messages: [{ role: "user", parts: [{ _tag: "Text", text: "Hello" }] }] },
        TurnId.make("turn-1"),
      );
    }).pipe(Effect.provide(OpenAiModelClient.pipe(Layer.provide(openAiAt(provider.url))))),
  );
  if (responded._tag !== "ModelFailed") throw new Error(`expected ModelFailed, got ${responded._tag}`);
  expect((JSON.parse(asText(responded.error)) as { readonly reason: { readonly _tag: string } }).reason._tag).toBe("UnknownError");
});

test("a required tool choice and a constrained tool are not sent to the Responses API, and a warning names each", () => {
  const [add, ...rest] = smolCatalog;
  if (add === undefined) throw new Error("the smol catalog has no tools");
  const context: ModelContext = {
    system: undefined,
    tools: [{ ...add, constrained: true }, ...rest],
    messages: [{ role: "user", parts: [{ _tag: "Text", text: "Add 2 and 3." }] }],
    toolChoice: "required",
  };
  const shaped = body({ provider: ProviderName.make("boring"), model: ModelName.make("boring-1") }, context);
  const sent = shaped.json as { readonly tools: ReadonlyArray<Record<string, unknown>> };
  expect(sent).not.toHaveProperty("tool_choice");
  expect(sent.tools.every((tool) => !("strict" in tool))).toBe(true);
  expect(shaped.supplied.filter((entry) => entry.event === logKeys.provider.notTranslated).map((entry) => [entry.level, entry.details["field"]])).toEqual([
    ["warning", "toolChoice"],
    ["warning", "constrained"],
  ]);
});
