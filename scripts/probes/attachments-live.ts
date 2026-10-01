/**
 * Live probe: one input with two attachments, an image (left half red, right half blue) and a PDF
 * (one page saying "The secret word is papaya."), sent to a real model through the loop. The bytes
 * go in the blob store and the facts hold references. Prints the model's answer and the transcript's
 * path; the answer should name both colours and the word.
 *
 * With `tool`, the image comes from a tool instead: the model is given a `look` tool that returns
 * it, and asked what colours it shows; the answer should name both.
 *
 *   ANTHROPIC_API_KEY=... bun scripts/probes/attachments-live.ts anthropic claude-sonnet-5-5
 *   OPENAI_API_KEY=...    bun scripts/probes/attachments-live.ts openai gpt-5.5
 *   XAI_API_KEY=...       bun scripts/probes/attachments-live.ts xai grok-4.7
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { AnthropicClient } from "@effect/ai-anthropic";
import { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer, Redacted, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Fact } from "../../src/agent-machine/fact.ts";
import { InputText, ModelName, ProviderName, SessionId, TestName, ToolName } from "../../src/agent-machine/names.ts";
import { ToolRunner, type ToolSpec } from "../../src/agent-session/contracts.ts";
import { MediaType } from "../../src/agent-machine/received.ts";
import { Blobs, BlobsInMemory } from "../../src/agent-session/blobs.ts";
import { openSession } from "../../src/agent-session/loop.ts";
import { ModelFromFacts } from "../../src/agent-session/model-choice.ts";
import { reportedBy } from "../../src/agent-session/origin.ts";
import { AnthropicModelClient } from "../../src/agent-session/providers/anthropic-client.ts";
import { OpenAiModelClient } from "../../src/agent-session/providers/openai-client.ts";
import { xAiClient, XAiModelClient } from "../../src/agent-session/providers/xai-client.ts";
import { openedWith } from "../../src/agent-session/session-setup.ts";
import { TurnContextAssembler } from "../../src/agent-session/turn-context.ts";
import { CountingTurns, NoTurnEndHooks } from "../../src/agent-session/turns.ts";
import { SmolToolRunner } from "../../tests/support/smol-tools.ts";
import { transcript } from "./transcript.ts";

const [provider = "anthropic", model = "claude-sonnet-5-5", mode] = process.argv.slice(2);
const viaTool = mode === "tool";
const variable = provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "xai" ? "XAI_API_KEY" : "OPENAI_API_KEY";
const key = process.env[variable];
if (key === undefined || key === "") {
  console.error(`${variable} is not set`);
  process.exit(2);
}
const apiKey = Redacted.make(key);
const http = FetchHttpClient.layer;
const client =
  provider === "anthropic"
    ? AnthropicModelClient.pipe(Layer.provide(AnthropicClient.layer({ apiKey }).pipe(Layer.provide(http))))
    : provider === "xai"
      ? XAiModelClient.pipe(Layer.provide(xAiClient(apiKey).pipe(Layer.provide(http))))
      : OpenAiModelClient.pipe(Layer.provide(OpenAiClient.layer({ apiKey }).pipe(Layer.provide(http))));

/** A 256×256 PNG, the left half red and the right half blue. */
function halves(): Uint8Array {
  const size = 256;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) raw[y * (size * 3 + 1) + 1 + x * 3 + (x < size / 2 ? 0 : 2)] = 255;
  const crc = (data: Buffer) => {
    let c = ~0;
    for (const byte of data) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(typed));
    return Buffer.concat([length, typed, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A one-page PDF saying "The secret word is papaya." */
function papaya(): Uint8Array {
  const text = "BT /F1 24 Tf 72 700 Td (The secret word is papaya.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: Array<number> = [];
  objects.forEach((object, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const look: ToolSpec = { name: ToolName.make("look"), description: "Returns the picture in front of you, as an image.", input: { type: "object", properties: {} } };
/** Runs `look`: its output is the image, as bytes, which the loop puts in the blob store. */
const Looking = Layer.succeed(ToolRunner, {
  run: () => Effect.succeed({ _tag: "Succeeded" as const, output: { mediaType: MediaType.make("image/png"), body: { _tag: "Bytes" as const, bytes: halves() } } }),
});

const facts = await Effect.runPromise(
  Effect.gen(function* () {
    const blobs = yield* Blobs;
    const image = yield* blobs.store(halves(), MediaType.make("image/png"), "halves.png");
    const document = yield* blobs.store(papaya(), MediaType.make("application/pdf"), "papaya.pdf");
    const session = yield* openSession;
    yield* session.observe(
      openedWith({
        session: SessionId.make("attachments"),
        model: { provider: ProviderName.make(provider), model: ModelName.make(model) },
        system: undefined,
        tools: viaTool ? [look] : [],
      }),
    );
    yield* session.idle;
    yield* session.observe(
      viaTool
        ? { _tag: "InputArrived", from: { _tag: "User" }, text: InputText.make("Use the look tool, then say what colours the image shows, left and right, in one line.") }
        : {
            _tag: "InputArrived",
            from: { _tag: "User" },
            text: InputText.make("What colours does the image show, left and right? What is the secret word in the PDF? Answer in one line."),
            attachments: [image, document],
          },
    );
    yield* session.idle;
    return yield* session.facts;
  }).pipe(
    reportedBy({ _tag: "Test", name: TestName.make(`attachments-live ${provider} ${model}`) }),
    Effect.scoped,
    Effect.provide(Layer.mergeAll(ModelFromFacts, TurnContextAssembler, client, CountingTurns, NoTurnEndHooks, viaTool ? Looking : SmolToolRunner, BlobsInMemory)),
  ),
);

const answer = facts.flatMap((fact) =>
  fact._tag === "Observed" && fact.observation._tag === "ModelResponded"
    ? fact.observation.parts.flatMap((part) => (part._tag === "Text" ? [part.text] : []))
    : [],
);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const name = [stamp, "attachments", provider, model].join("-");
mkdirSync("logs/live", { recursive: true });
writeFileSync(
  join("logs/live", `${name}.md`),
  transcript(`attachments-live ${provider} ${model}`, "One input with an image and a PDF attached, by `bun scripts/probes/attachments-live.ts`.", facts),
);
const encodeFact = Schema.encodeSync(Fact);
writeFileSync(join("logs/live", `${name}.facts.jsonl`), `${facts.map((fact) => JSON.stringify(encodeFact(fact))).join("\n")}\n`);
console.log(`answer: ${answer.join(" ") || "(none)"}`);
console.log(`logs/live/${name}.md`);
