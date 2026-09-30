/**
 * What every provider adapter does around one model request: post JSON through the provider's
 * configured HTTP client, fail with Effect's `AiError` when the request does not produce a usable
 * response, retry the failures `AiError` marks retryable, and end as `ModelFailed` when they are
 * used up. The whole error is logged where it is caught; the core sees a summary.
 */

import { Duration, Effect, Schema, Stream } from "effect";
import * as Sse from "effect/encoding/Sse";
import * as AiError from "effect/ai/AiError";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FailureText, type TurnId } from "../agent-core/names.ts";
import type { Observation } from "../agent-core/observation.ts";
import type { Received } from "../agent-core/received.ts";
import { ModelClient, type ProviderRequest } from "./contracts.ts";
import { receivedJson } from "./received.ts";
import { logKeys } from "./log-keys.ts";

type Json = Schema.Json;

/** Which adapter made the request, as `AiError` records it. */
export interface Caller {
  readonly module: string;
  readonly method: string;
}

/** How a request is retried: how many times at most, and the first wait, which doubles each time. */
export interface Retries {
  readonly times: number;
  readonly firstWait: Duration.Input;
}

export const defaultRetries: Retries = { times: 3, firstWait: "500 millis" };

const failure = (caller: Caller, reason: AiError.AiErrorReason): AiError.AiError =>
  AiError.make({ module: caller.module, method: caller.method, reason });

/**
 * The response to `payload` posted to `path`. A response that is not 2xx fails with the `AiError`
 * reason for its status, however it arrives: as a response, or, from a client that fails such
 * responses itself (Effect's OpenAI client does), inside a `StatusCodeError`.
 */
const send = (
  http: HttpClient.HttpClient,
  caller: Caller,
  path: string,
  payload: Json,
  headers: Readonly<Record<string, string>>,
): Effect.Effect<HttpClientResponse.HttpClientResponse, AiError.AiError> =>
  HttpClientRequest.post(path).pipe(
    HttpClientRequest.setHeaders(headers),
    HttpClientRequest.bodyJsonUnsafe(payload),
    http.execute,
    Effect.catchIf(
      (error): error is HttpClientError.HttpClientError & { readonly reason: HttpClientError.StatusCodeError } =>
        error.reason._tag === "StatusCodeError",
      (error) => Effect.succeed(error.reason.response),
    ),
    Effect.mapError(fromHttp(caller)),
    Effect.filterOrElse(
      (response) => response.status >= 200 && response.status <= 299,
      (response) =>
        response.text.pipe(
          Effect.mapError(fromHttp(caller)),
          Effect.flatMap((text) =>
            Effect.fail(
              failure(
                caller,
                AiError.reasonFromHttpStatus({ status: response.status, body: text, description: `HTTP ${response.status}: ${text}` }),
              ),
            ),
          ),
        ),
    ),
  );

const fromHttp =
  (caller: Caller) =>
  (error: HttpClientError.HttpClientError): AiError.AiError => {
    const reason = error.reason;
    switch (reason._tag) {
      case "TransportError":
      case "EncodeError":
      case "InvalidUrlError":
        return failure(caller, AiError.NetworkError.fromRequestError(reason));
      default:
        return failure(caller, new AiError.UnknownError({ description: reason.message }));
    }
  };

const parsed = (caller: Caller, text: string): Effect.Effect<Json, AiError.AiError> =>
  Effect.try({
    try: () => JSON.parse(text) as Json,
    catch: () => failure(caller, new AiError.InvalidOutputError({ description: `The response is not JSON: ${text}` })),
  });

/** The response to `payload` posted to `path`, parsed as JSON. */
export const postJson = (
  http: HttpClient.HttpClient,
  caller: Caller,
  path: string,
  payload: Json,
  headers: Readonly<Record<string, string>> = {},
): Effect.Effect<Json, AiError.AiError> =>
  send(http, caller, path, payload, headers).pipe(
    Effect.flatMap((response) => response.text.pipe(Effect.mapError(fromHttp(caller)))),
    Effect.flatMap((text) => parsed(caller, text)),
  );

/**
 * The response to `payload` posted to `path`, as the server-sent events it streams: each event's
 * data, parsed as JSON, as it arrives.
 */
export const postEvents = (
  http: HttpClient.HttpClient,
  caller: Caller,
  path: string,
  payload: Json,
  headers: Readonly<Record<string, string>> = {},
): Stream.Stream<Json, AiError.AiError> =>
  send(http, caller, path, payload, headers).pipe(
    Effect.map((response) => response.stream),
    Stream.unwrap,
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.mapError((error) => {
      if (AiError.isAiError(error)) return error;
      switch (error._tag) {
        case "Retry":
          return failure(caller, new AiError.UnknownError({ description: "The event stream asked to be retried" }));
        case "SseError":
          return failure(caller, new AiError.InvalidOutputError({ description: `The event stream could not be read: ${error.message}` }));
        default:
          return fromHttp(caller)(error);
      }
    }),
    Stream.mapEffect((event) => parsed(caller, event.data)),
  );

/** Fails with the response's text, when a provider's response does not have the shape expected. */
export const invalidOutput = (caller: Caller, description: string): AiError.AiError =>
  failure(caller, new AiError.InvalidOutputError({ description }));

/**
 * Retries `request` while its failure is retryable, at most `retries.times` times. The wait before
 * a retry is `firstWait`, doubled each time, or what a rate limit says to wait when it says. Each
 * retry is logged before it is made.
 */
export const withRetries =
  (retries: Retries) =>
  <A>(request: Effect.Effect<A, AiError.AiError>): Effect.Effect<A, AiError.AiError> => {
    const attempt = (retried: number): Effect.Effect<A, AiError.AiError> =>
      request.pipe(
        Effect.catch((error: AiError.AiError) => {
          if (!error.reason.isRetryable || retried >= retries.times) return Effect.fail(error);
          const wait =
            error.reason._tag === "RateLimitError" && error.reason.retryAfter !== undefined
              ? error.reason.retryAfter
              : Duration.times(Duration.fromInputUnsafe(retries.firstWait), 2 ** retried);
          return Effect.logWarning(logKeys.provider.requestRetried, {
            reason: error.reason._tag,
            message: error.message,
            retry: retried + 1,
            of: retries.times,
            wait: Duration.format(wait),
          }).pipe(Effect.andThen(Effect.sleep(wait)), Effect.andThen(attempt(retried + 1)));
        }),
      );
    return attempt(0);
  };

/** A model client that makes `request`, and reports a failure as `ModelFailed`. */
export const modelClientOf = (request: ProviderRequest) =>
  ModelClient.of({
    respond: (target, context, turn) => request(target, context, turn).pipe(Effect.catch(failedAs(turn))),
  });

const encodeAiError = Schema.encodeSync(Schema.toCodecJson(AiError.AiError));

/** The error as JSON, in `AiError`'s own encoding, which decodes back to the same error. */
export const receivedAiError = (error: AiError.AiError): Received => receivedJson(encodeAiError(error) as Json);

/** Ends as `ModelFailed` for `turn`, carrying the encoded error, and logs the whole error. */
export const failedAs =
  (turn: TurnId) =>
  (error: AiError.AiError): Effect.Effect<Extract<Observation, { _tag: "ModelFailed" }>> =>
    Effect.logError(logKeys.provider.requestFailed, {
      reason: error.reason._tag,
      retryable: error.reason.isRetryable,
      message: error.message,
      module: error.module,
      method: error.method,
    }).pipe(
      Effect.as({
        _tag: "ModelFailed" as const,
        turn,
        failure: FailureText.make(error.message),
        error: receivedAiError(error),
      }),
    );
