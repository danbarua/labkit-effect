/**
 * What a host reads of a response as it arrives, from `streamed` alone: the text each event adds to
 * a part (`ModelDelta`), joined, is that part's text and comes before it; and each model request
 * ends with `ModelResponseEnded`, however it ended. The same for each provider's adapter.
 */

import { afterAll, expect } from "bun:test";
import { Effect, Layer, PubSub } from "effect";
import { Millis } from "../../agent-machine/names.ts";
import type { CapturedObservation, Observation } from "../../agent-machine/observation.ts";
import { BoringModelProvider, boringOpening } from "../../../tests/support/boring.ts";
import { anthropicAt, openAiAt, openAiCompatAt } from "../../../tests/support/providers.ts";
import { runTest } from "../../../tests/support/run.ts";
import { SmolToolRunner, smolCatalog } from "../../../tests/support/smol-tools.ts";
import { anthropicStream, chatChunks, chatStream, openAiStream } from "../../../tests/support/streams.ts";
import { test } from "../../../tests/support/test.ts";
import type { ModelClient } from "../contracts.ts";
import { openSession } from "../loop.ts";
import { ModelStreamInterval } from "../model-stream.ts";
import { EphemeralSessionStore } from "../session-store.ts";
import { TurnContextAssembler } from "../turn-context.ts";
import { CountingTurns, NoTurnEndHooks } from "../turns.ts";
import { AnthropicModelClient } from "./anthropic-client.ts";
import { openAiCompatModelClient } from "./openai-compat-client.ts";
import { OpenAiModelClient } from "./openai-client.ts";

const stops: Array<() => unknown> = [];
afterAll(() => {
  for (const stop of stops) stop();
});

/** A server that answers each request with `respond`, given its number. */
const serving = (respond: (request: number) => Response) => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.json();
      return respond(++requests);
    },
  });
  stops.push(() => server.stop(true));
  return server.url;
};

/** One turn through `client`: what `streamed` passed on, in order. */
const streamedIn = (client: Layer.Layer<ModelClient>) =>
  runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      const streamed = yield* session.streamed;
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "What is 2 + 3?" } as unknown as Observation);
      yield* session.idle;
      return yield* PubSub.takeAll(streamed);
    }).pipe(
      Effect.provide(Layer.mergeAll(BoringModelProvider, TurnContextAssembler, client, CountingTurns, NoTurnEndHooks, SmolToolRunner)),
      Effect.provideService(ModelStreamInterval, Millis.make(0)),
    ),
  );

/**
 * Each part that has text, with the deltas of its kind that came after the last such part and
 * before it, joined: what a host pairing deltas to parts by kind would show for it.
 */
const paired = (passed: ReadonlyArray<CapturedObservation>) => {
  const pending = new Map<string, string>();
  return passed.flatMap((item) => {
    if (item._tag === "ModelDelta") pending.set(item.kind, (pending.get(item.kind) ?? "") + item.text);
    if (item._tag !== "ModelPartArrived") return [];
    const { part } = item;
    if (part._tag !== "Text" && part._tag !== "Commentary" && part._tag !== "Thinking") return [];
    const shown = pending.get(part._tag) ?? "";
    pending.delete(part._tag);
    return [{ kind: part._tag as string, text: part.text as string, shown }];
  });
};

const tags = (passed: ReadonlyArray<CapturedObservation>): Array<string> => passed.map((item) => item._tag);

test("V3 V4: Anthropic: the deltas of thinking and of the answer, joined, are each part's text; each request ends last", async () => {
  const url = serving((request) =>
    anthropicStream(
      request === 1
        ? {
            content: [
              { type: "thinking", thinking: "Two and three.", signature: "sig" },
              { type: "text", text: "Adding." },
              { type: "tool_use", id: "toolu_1", name: "add", input: { a: 2, b: 3 } },
            ],
            stop_reason: "tool_use",
          }
        : { content: [{ type: "text", text: "5." }], stop_reason: "end_turn" },
    ),
  );
  const passed = await streamedIn(AnthropicModelClient.pipe(Layer.provide(anthropicAt(new URL("/v1/messages", url)))));
  expect(paired(passed)).toEqual([
    { kind: "Thinking", text: "Two and three.", shown: "Two and three." },
    { kind: "Text", text: "Adding.", shown: "Adding." },
    { kind: "Text", text: "5.", shown: "5." },
  ]);
  expect(tags(passed).filter((tag) => tag === "ModelResponseEnded")).toHaveLength(2);
  expect(tags(passed).at(-1)).toBe("ModelResponseEnded");
  // No deltas for a tool call.
  expect(passed.filter((item) => item._tag === "ModelDelta").every((item) => item.text !== '{"a":2,"b":3}')).toBe(true);
});

test("V3: OpenAI Responses: commentary, a two-part reasoning summary, and the answer, each its deltas joined", async () => {
  const url = serving(() =>
    openAiStream({
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "First, add." }, { type: "summary_text", text: "Then answer." }] },
        { type: "message", id: "m_1", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Working on it." }] },
        { type: "message", id: "m_2", role: "assistant", content: [{ type: "output_text", text: "5." }] },
      ],
    }),
  );
  const passed = await streamedIn(OpenAiModelClient.pipe(Layer.provide(openAiAt(url))));
  expect(paired(passed)).toEqual([
    { kind: "Thinking", text: "First, add.\n\nThen answer.", shown: "First, add.\n\nThen answer." },
    { kind: "Commentary", text: "Working on it.", shown: "Working on it." },
    { kind: "Text", text: "5.", shown: "5." },
  ]);
  expect(tags(passed).at(-1)).toBe("ModelResponseEnded");
});

test("V3: Chat Completions: the thinking field and the content, each its deltas joined; a server that answers whole has none", async () => {
  const whole = { id: "c1", choices: [{ index: 0, message: { role: "assistant", reasoning_content: "Two and three.", content: "5." }, finish_reason: "stop" }] };
  const streaming = serving(() => chatStream(whole));
  const passed = await streamedIn(openAiCompatModelClient({ times: 0, firstWait: "1 millis" }).pipe(Layer.provide(openAiCompatAt(streaming))));
  expect(paired(passed)).toEqual([
    { kind: "Thinking", text: "Two and three.", shown: "Two and three." },
    { kind: "Text", text: "5.", shown: "5." },
  ]);
  const answeringWhole = serving(() => Response.json(whole));
  const fromWhole = await streamedIn(openAiCompatModelClient({ times: 0, firstWait: "1 millis" }).pipe(Layer.provide(openAiCompatAt(answeringWhole))));
  expect(tags(fromWhole)).not.toContain("ModelDelta");
  expect(tags(fromWhole).at(-1)).toBe("ModelResponseEnded");
});

test("V3: Chat Completions: Mistral's content, a list of chunks, then text: the thinking and the text, each its deltas joined", async () => {
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: "m1", choices: [{ index: 0, delta, finish_reason }] });
  const think = (text: string) => ({ type: "thinking", thinking: [{ type: "text", text }] });
  const url = serving(() =>
    chatChunks([
      chunk({ role: "assistant", content: [think("Two and ")] }),
      chunk({ content: [think("three."), { type: "text", text: "Fi" }] }),
      chunk({ content: "ve." }),
      chunk({}, "stop"),
    ]),
  );
  const passed = await streamedIn(openAiCompatModelClient({ times: 0, firstWait: "1 millis" }).pipe(Layer.provide(openAiCompatAt(url))));
  expect(paired(passed)).toEqual([
    { kind: "Thinking", text: "Two and three.", shown: "Two and three." },
    { kind: "Text", text: "Five.", shown: "Five." },
  ]);
});

test("V4: a request that fails ends with ModelResponseEnded too", async () => {
  const url = serving(() => new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400, headers: { "content-type": "application/json" } }));
  const passed = await streamedIn(openAiCompatModelClient({ times: 0, firstWait: "1 millis" }).pipe(Layer.provide(openAiCompatAt(url))));
  expect(tags(passed)).toEqual(["ModelResponseEnded"]);
});
