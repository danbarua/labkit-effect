import { AnthropicClient } from "@effect/ai-anthropic";
import { OpenAiClient } from "@effect/ai-openai";
import { OpenAiClient as OpenAiCompatClient } from "@effect/ai-openai-compat";
import { Layer, Redacted } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { openAiStream } from "./streams.ts";

/** Effect's Anthropic client, sending requests to a local test server at `server`. */
export function anthropicAt(server: URL) {
  return AnthropicClient.layer({ apiUrl: server.origin, apiKey: Redacted.make("test-key") }).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
}

/** Effect's OpenAI client, sending requests to a local test server at `server`. */
export function openAiAt(server: URL) {
  return OpenAiClient.layer({ apiUrl: server.origin, apiKey: Redacted.make("test-key") }).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
}

/** Effect's OpenAI-compatible client, sending requests to a local test server at `server`. */
export function openAiCompatAt(server: URL) {
  return OpenAiCompatClient.layer({ apiUrl: server.origin, apiKey: Redacted.make("test-key") }).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
}

/** A local server that answers each request with the next scripted body, keeping each request. */
export function recordingServer(responses: ReadonlyArray<unknown>) {
  const bodies: Array<unknown> = [];
  const headers: Array<Record<string, string>> = [];
  const paths: Array<string> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      paths.push(new URL(request.url).pathname);
      headers.push(Object.fromEntries(request.headers));
      bodies.push(await request.json());
      const response = responses[Math.min(bodies.length - 1, responses.length - 1)];
      // The Responses adapter streams; the Chat Completions adapter does not.
      return paths.at(-1) === "/responses" ? openAiStream(response) : Response.json(response);
    },
  });
  return { url: server.url, bodies, headers, paths, stop: () => server.stop(true) };
}
