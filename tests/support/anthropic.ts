import { AnthropicClient } from "@effect/ai-anthropic";
import { Layer, Redacted } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

/** Effect's Anthropic client, configured to send requests to a local test server at `server`. */
export function anthropicAt(server: URL) {
  return AnthropicClient.layer({ apiUrl: server.origin, apiKey: Redacted.make("test-key") }).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
}
