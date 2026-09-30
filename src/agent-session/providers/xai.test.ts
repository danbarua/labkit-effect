/**
 * Grok through the Responses adapter: its stream as xAI sends it, its settings, its reasoning sent
 * back, and its own compaction. `grok-stream.json` is a stream xAI sent, with its text shortened.
 */

import { afterAll, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { ModelName, ProviderName } from "../../agent-machine/names.ts";
import type { Observation } from "../../agent-machine/observation.ts";
import { ContextAssembler, type ModelContext, ModelProvider } from "../contracts.ts";
import { openSession } from "../loop.ts";
import { receivedJson } from "../received.ts";
import { TurnContextAssembler } from "../turn-context.ts";
import { CountingTurns, NoTurnEndHooks } from "../turns.ts";
import { openAiCompactions } from "./openai-compaction.ts";
import { XAiModelClient } from "./xai-client.ts";
import grokStream from "./grok-stream.json" with { type: "json" };
import { boringOpening } from "../../../tests/support/boring.ts";
import { openAiAt, recordingServer } from "../../../tests/support/providers.ts";
import { json } from "../../../tests/support/received.ts";
import { runTest } from "../../../tests/support/run.ts";
import { SmolToolRunner, smolCatalog } from "../../../tests/support/smol-tools.ts";
import { openAiStream } from "../../../tests/support/streams.ts";
import { test } from "../../../tests/support/test.ts";

const stops: Array<() => unknown> = [];
afterAll(() => {
  for (const stop of stops) stop();
});

const grok = { provider: ProviderName.make("xai"), model: ModelName.make("grok-4.7") };
const input = { _tag: "InputArrived", from: { _tag: "User" }, text: "What is 2 + 3?" } as unknown as Observation;

/** A server that sends `first` as its first answer, as it is, and each later one as `openAiStream` makes it. */
function serving(first: Response, later: unknown) {
  const bodies: Array<Record<string, unknown>> = [];
  const paths: Array<string> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      paths.push(new URL(request.url).pathname);
      bodies.push((await request.json()) as Record<string, unknown>);
      return bodies.length === 1 ? first : openAiStream(later);
    },
  });
  stops.push(() => server.stop(true));
  return { url: server.url, bodies, paths };
}

const asEvents = (events: ReadonlyArray<{ readonly type: string }>) =>
  new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

async function session(url: URL, settings: object, context?: ModelContext) {
  return runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.observe(input);
      yield* session.idle;
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ModelProvider, { select: () => Effect.succeed({ ...grok, settings }) }),
          context === undefined ? TurnContextAssembler : Layer.succeed(ContextAssembler, { assemble: () => Effect.succeed(context) }),
          XAiModelClient.pipe(Layer.provide(openAiAt(url))),
          CountingTurns,
          NoTurnEndHooks,
          SmolToolRunner,
        ),
      ),
    ),
  );
}

const answers = { status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "5." }] }] };

test("Grok's stream as it sends it: the reasoning item is Thinking and the call a ToolCall, and both go back as received", async () => {
  const provider = serving(asEvents(grokStream), answers);
  const facts = await session(provider.url, {});
  const completed = grokStream.at(-1) as unknown as { response: { output: ReadonlyArray<Record<string, unknown>> } };
  const [reasoning, call] = completed.response.output;
  const responses = facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === "ModelResponded" ? [fact.observation] : []));
  expect(responses as unknown).toMatchObject([
    {
      provider: "xai",
      stop: "completed",
      parts: [
        { _tag: "Thinking", text: "Two primes to find, then add.", received: json(reasoning) },
        { _tag: "ToolCall", call: call?.["call_id"], tool: "add", input: { body: { _tag: "Text", text: '{"a":1873.0,"b":4127.0}' } } },
      ],
    },
    // A message without a `phase`, as Grok sends every message, is the answer.
    { parts: [{ _tag: "Text", text: "5." }] },
  ]);
  expect(provider.paths).toEqual(["/responses", "/responses"]);
  const sent = provider.bodies[1]?.["input"] as ReadonlyArray<unknown>;
  expect(sent.slice(1)).toEqual([
    reasoning,
    { type: "function_call", call_id: call?.["call_id"], name: "add", arguments: '{"a":1873,"b":4127}' },
    { type: "function_call_output", call_id: call?.["call_id"], output: "6000" },
  ]);
  expect(facts.at(-1) as unknown).toMatchObject({ decision: { _tag: "TurnEnded", ending: { _tag: "Answered" } } });
});

test("settings go in as xAI takes them, and what it cannot take is recorded as enforced before the request", async () => {
  const provider = serving(openAiStream(answers), answers);
  const facts = await session(provider.url, { effort: "max", observe: "off", cache: "1h" });
  expect(provider.bodies[0]).toMatchObject({ model: "grok-4.7", stream: true, reasoning: { effort: "xhigh" } });
  expect(provider.bodies[0]).not.toHaveProperty("prompt_cache_retention");
  const enforced = facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === "SettingEnforced" ? [fact.observation.enforced] : []));
  expect(enforced as unknown).toEqual([
    { _tag: "Cache", asked: "1h" },
    { _tag: "Observe", asked: "off", used: "all" },
    { _tag: "Effort", asked: "max", used: "xhigh" },
  ]);
});

const compaction = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" };

test("a compaction item Grok returned heads the input, sent back unchanged; the system prompt goes in instructions", async () => {
  const provider = serving(openAiStream(answers), answers);
  const context = (from: ProviderName): ModelContext => ({
    system: "Be brief.",
    tools: [],
    messages: [
      { role: "instruction", parts: [{ _tag: "Unrecognised", provider: from, received: receivedJson(compaction) }] },
      { role: "user", parts: [{ _tag: "Text", text: "And now?" }] },
    ],
  });
  await session(provider.url, {}, context(grok.provider));
  await session(provider.url, {}, context(ProviderName.make("openai")));
  const question = { role: "user", content: [{ type: "input_text", text: "And now?" }] };
  expect(provider.bodies[0]).toMatchObject({ instructions: "Be brief.", input: [compaction, question] });
  // Another provider's compaction item is not sent to Grok.
  expect(provider.bodies[1]).toMatchObject({ input: [question] });
});

test("the provider's own compaction: the context goes to /responses/compact, and its output items come back as received", async () => {
  const returned = {
    id: "cmp_1",
    object: "response.compaction",
    model: "grok-4.7",
    output: [compaction],
    usage: { input_tokens: 3354, output_tokens: 386, dropped_message_count: 3 },
  };
  const provider = recordingServer([returned]);
  stops.push(provider.stop);
  const compacted = await Effect.runPromise(
    Effect.gen(function* () {
      const compact = yield* openAiCompactions();
      return yield* compact(grok, {
        system: "Be brief.",
        tools: [],
        messages: [
          { role: "user", parts: [{ _tag: "Text", text: "What is 2 + 3?" }] },
          { role: "assistant", parts: [{ _tag: "Text", text: "5." }] },
        ],
      });
    }).pipe(Effect.provide(openAiAt(provider.url))),
  );
  expect(provider.paths).toEqual(["/responses/compact"]);
  expect(provider.bodies).toEqual([
    {
      model: "grok-4.7",
      instructions: "Be brief.",
      input: [
        { role: "user", content: [{ type: "input_text", text: "What is 2 + 3?" }] },
        { role: "assistant", content: [{ type: "output_text", text: "5." }] },
      ],
    },
  ]);
  const { output: _output, ...metadata } = returned;
  expect(compacted).toEqual({ output: receivedJson([compaction]), metadata: receivedJson(metadata) });
});
