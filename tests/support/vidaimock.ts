/**
 * VidaiMock for tests: `startVidaiMock` runs the binary `scripts/vidaimock.ts` installs, on a free
 * local port, and the `*AtMock` layers point Effect's provider clients at it. A client given
 * `status` sends `X-Mock-Status` with every request, so the mock answers with that HTTP status and
 * the provider's own error body.
 */

import { AnthropicClient } from "@effect/ai-anthropic";
import { OpenAiClient } from "@effect/ai-openai";
import { OpenAiClient as OpenAiCompatClient } from "@effect/ai-openai-compat";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Layer, Redacted } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { binaryPath } from "../../scripts/vidaimock.ts";

export interface VidaiMock {
  readonly url: URL;
  readonly stop: () => void;
}

/** Starts VidaiMock on a free port of 127.0.0.1, once it has said where it listens. */
export async function startVidaiMock(): Promise<VidaiMock> {
  const binary = join(import.meta.dir, "..", "..", binaryPath);
  if (!existsSync(binary)) throw new Error(`VidaiMock is not installed at ${binary}: run \`bun scripts/vidaimock.ts\``);
  const process = Bun.spawn([binary, "--host", "127.0.0.1", "--port", "0"], { stdout: "pipe", stderr: "pipe" });
  const reader = process.stdout.getReader();
  const decoder = new TextDecoder();
  const read = async (seen: string): Promise<URL> => {
    const found = /http:\/\/127\.0\.0\.1:\d+/.exec(seen);
    if (found !== null) return new URL(found[0]);
    const { value, done } = await reader.read();
    if (done) throw new Error(`VidaiMock exited before saying where it listens; it printed: ${seen}`);
    return read(seen + decoder.decode(value));
  };
  const url = await read("");
  reader.releaseLock();
  return { url, stop: () => process.kill() };
}

const withStatus = (status: number | undefined) =>
  status === undefined
    ? undefined
    : HttpClient.mapRequest(HttpClientRequest.setHeader("X-Mock-Status", String(status)));

/** Effect's Anthropic client, at the mock; with `status`, every request is answered with it. */
export const anthropicAtMock = (mock: VidaiMock, status?: number) =>
  AnthropicClient.layer({
    apiUrl: mock.url.origin,
    apiKey: Redacted.make("test-key"),
    transformClient: withStatus(status),
  }).pipe(Layer.provide(FetchHttpClient.layer));

/** Effect's OpenAI client, at the mock's `/v1`; with `status`, every request is answered with it. */
export const openAiAtMock = (mock: VidaiMock, status?: number) =>
  OpenAiClient.layer({
    apiUrl: `${mock.url.origin}/v1`,
    apiKey: Redacted.make("test-key"),
    transformClient: withStatus(status),
  }).pipe(Layer.provide(FetchHttpClient.layer));

/** Effect's OpenAI-compatible client, at the mock's `/v1`; with `status`, every request is answered with it. */
export const openAiCompatAtMock = (mock: VidaiMock, status?: number) =>
  OpenAiCompatClient.layer({
    apiUrl: `${mock.url.origin}/v1`,
    apiKey: Redacted.make("test-key"),
    transformClient: withStatus(status),
  }).pipe(Layer.provide(FetchHttpClient.layer));
