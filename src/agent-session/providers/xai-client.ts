/**
 * Grok, reached through the OpenAI Responses adapter (`openai-client.ts`) with the client's URL set to
 * xAI's, and the session's settings mapped as xAI accepts them (`xai-settings.ts`). xAI accepts
 * Responses requests as OpenAI's API does, under OpenAI's names, and streams the same events; its
 * responses differ where `grok.md` describes. The endpoint's reference:
 * https://docs.x.ai/developers/rest-api-reference/inference/responses.md
 */

import { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer, type Redacted } from "effect";
import { ModelClient } from "../contracts.ts";
import { defaultRetries, modelClientOf, type Retries } from "../provider-call.ts";
import { openAiRequests } from "./openai-client.ts";
import { xAiSettle } from "./xai-settings.ts";

export const xAiApiUrl = "https://api.x.ai/v1";

/** Effect's OpenAI client, sending requests to xAI with `apiKey`. It requires an `HttpClient`. */
export const xAiClient = (apiKey: Redacted.Redacted) => OpenAiClient.layer({ apiUrl: xAiApiUrl, apiKey });

/** Makes requests to Grok through the configured `OpenAiClient`, which `xAiClient` points at xAI. */
export const xAiRequests = (retries: Retries = defaultRetries) => openAiRequests(retries, xAiSettle);

export const xAiModelClient = (retries: Retries = defaultRetries) =>
  Layer.effect(ModelClient, xAiRequests(retries).pipe(Effect.map(modelClientOf)));

export const XAiModelClient = xAiModelClient();
