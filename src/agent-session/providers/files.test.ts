/**
 * Files in a request: the facts and the request's record hold references; each adapter reads the
 * bytes from the blob store and sends them as its provider takes them, or the file's pointer when
 * the model is not known to take that kind or the store does not hold the bytes.
 */

import { afterAll, expect } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { anthropicStream } from "../../../tests/support/streams.ts";
import { anthropicAt, openAiAt, openAiCompatAt, recordingServer } from "../../../tests/support/providers.ts";
import { runTest } from "../../../tests/support/run.ts";
import { test } from "../../../tests/support/test.ts";
import type { BlobRef } from "../../agent-machine/blob.ts";
import { ModelName, ProviderName, TurnId } from "../../agent-machine/names.ts";
import { MediaType } from "../../agent-machine/received.ts";
import { Blobs, BlobsInMemory } from "../blobs.ts";
import { type ContextPart, ModelClient, ModelContext } from "../contracts.ts";
import { blobPointer } from "../shaping.ts";
import { AnthropicModelClient } from "./anthropic-client.ts";
import { OpenAiModelClient } from "./openai-client.ts";
import { OpenAiCompatModelClient } from "./openai-compat-client.ts";

const stops: Array<() => unknown> = [];
afterAll(() => {
  for (const stop of stops) stop();
});

const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const pdf = new TextEncoder().encode("%PDF-1.7 a page");
const notes = new TextEncoder().encode("Remember the milk.");
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** Stores the three files, then asks `client` for a response to a message carrying them (and one the store lacks). */
const sent = (client: Layer.Layer<ModelClient>, provider: string, model: string) =>
  runTest(
    Effect.gen(function* () {
      const blobs = yield* Blobs;
      const files = [
        yield* blobs.store(png, MediaType.make("image/png"), "chart.png"),
        yield* blobs.store(pdf, MediaType.make("application/pdf"), "report.pdf"),
        yield* blobs.store(notes, MediaType.make("text/plain"), "notes.txt"),
      ];
      const missing: BlobRef = { ...(files[0] as BlobRef), id: "0".repeat(64) as BlobRef["id"] };
      const context: ModelContext = {
        system: undefined,
        tools: [],
        messages: [
          {
            role: "user",
            parts: [{ _tag: "Text", text: "What do these show?" }, ...[...files, missing].map((blob): ContextPart => ({ _tag: "File", blob }))],
          },
        ],
      };
      yield* (yield* ModelClient).respond({ provider: ProviderName.make(provider), model: ModelName.make(model) }, context, TurnId.make("turn-1"));
      return { files: files as ReadonlyArray<BlobRef>, missing, context };
    }).pipe(Effect.provide(Layer.mergeAll(client, BlobsInMemory))),
  );

test("Anthropic: an image as an image block, a PDF as a document block, a text file as its text; a file the store lacks as its pointer", async () => {
  const bodies: Array<unknown> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push(await request.json());
      return anthropicStream({ content: [{ type: "text", text: "A chart." }], stop_reason: "end_turn" });
    },
  });
  stops.push(() => server.stop(true));
  const { files, missing } = await sent(
    AnthropicModelClient.pipe(Layer.provide(anthropicAt(new URL("/v1/messages", server.url)))),
    "anthropic",
    "claude-sonnet-5-5",
  );
  const [chart, report, list] = files as [BlobRef, BlobRef, BlobRef];
  expect((bodies[0] as { messages: Array<{ content: unknown }> }).messages[0]?.content as unknown).toEqual([
    { type: "text", text: "What do these show?" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: base64(png) } },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64(pdf) } },
    { type: "text", text: `${blobPointer(list)}\nRemember the milk.` },
    { type: "text", text: blobPointer(missing) },
  ]);
  expect(chart.id).toMatch(/^[0-9a-f]{64}$/);
  expect(report.size).toBe(pdf.byteLength);
});

test("OpenAI Responses: an image as input_image, a PDF as input_file, each a data URL; a model not known to take files gets pointers", async () => {
  const answer = { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "A chart." }] }] };
  const known = recordingServer([answer]);
  stops.push(known.stop);
  await sent(OpenAiModelClient.pipe(Layer.provide(openAiAt(known.url))), "openai", "gpt-5.5");
  const input = (known.bodies[0] as { input: Array<{ content: Array<Record<string, unknown>> }> }).input;
  expect(input.map((item) => item.content[0]?.["type"])).toEqual(["input_text", "input_image", "input_file", "input_text", "input_text"]);
  expect(input[1]?.content[0]).toEqual({ type: "input_image", image_url: `data:image/png;base64,${base64(png)}` });
  expect(input[2]?.content[0]).toEqual({ type: "input_file", filename: "report.pdf", file_data: `data:application/pdf;base64,${base64(pdf)}` });

  const unknown = recordingServer([answer]);
  stops.push(unknown.stop);
  const { files } = await sent(OpenAiModelClient.pipe(Layer.provide(openAiAt(unknown.url))), "openai", "boring-1");
  const unknownInput = (unknown.bodies[0] as { input: Array<{ content: Array<Record<string, unknown>> }> }).input;
  expect(unknownInput[1]?.content[0]).toEqual({ type: "input_text", text: blobPointer(files[0] as BlobRef) });
});

test("Chat Completions: an image as image_url, a PDF as its pointer", async () => {
  const provider = recordingServer([{ id: "c", choices: [{ index: 0, message: { role: "assistant", content: "A chart." }, finish_reason: "stop" }] }]);
  stops.push(provider.stop);
  const { files } = await sent(OpenAiCompatModelClient.pipe(Layer.provide(openAiCompatAt(provider.url))), "openai", "gpt-5.5");
  const content = (provider.bodies[0] as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages[0]?.content;
  expect(content?.[1]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${base64(png)}` } });
  expect(content?.[2]).toEqual({ type: "text", text: blobPointer(files[1] as BlobRef) });
});

/** A model client that answers without sending anything, for the record's test. */
const ModelClientStub = Layer.succeed(ModelClient, {
  respond: (target, _context, turn) =>
    Effect.succeed({
      _tag: "ModelResponded" as const,
      turn,
      provider: target.provider,
      model: target.model,
      parts: [],
      ending: { _tag: "Complete" as const },
      metadata: { mediaType: MediaType.make("application/json"), body: { _tag: "Text" as const, text: "{}" as never } },
    }),
});

test("what a request carried is recorded with its files by reference: no bytes", async () => {
  const { context } = await sent(ModelClientStub, "boring", "boring-1");
  const recorded = JSON.stringify(Schema.encodeSync(Schema.toCodecJson(ModelContext))(context));
  expect(recorded).not.toContain(base64(png));
  expect(recorded).toContain('"_tag":"File"');
});
