/**
 * What every provider adapter does around one model request: post JSON through the provider's
 * configured HTTP client, fail with Effect's `AiError` when the request does not produce a usable
 * response, retry the failures `AiError` marks retryable that come before a response begins, and
 * end as `ModelFailed` otherwise, carrying the error and the request as it was posted. The whole
 * error is logged where it is caught.
 */

import { Context, Data, Duration, Effect, Ref, Schema, Stream } from "effect";
import * as Sse from "effect/encoding/Sse";
import * as AiError from "effect/ai/AiError";
import type * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FailureText, type TurnId } from "../agent-machine/names.ts";
import type { Observation } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";
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

/**
 * A request as it is posted: the path, the headers the adapter sets, and the body. The client's own
 * headers (the key, the API version) are set by the configured client and are not among them.
 */
export interface Post {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Json;
}

/** `post` as it is recorded with a failure. */
export const postedAs = (post: Post): Received => receivedJson({ path: post.path, headers: post.headers, body: post.body });

/**
 * A request that failed, once its retries are used up: the error, and the request as the model
 * client made it (`postedAs` for an adapter that posts over HTTP).
 */
export class RequestFailed extends Data.TaggedError("RequestFailed")<{
  readonly error: AiError.AiError;
  readonly request: Received;
}> {}

/** Fails with `RequestFailed`, carrying `post`, where `request` fails with an `AiError`. */
export const failedPosting =
  (post: Post) =>
  <A, R>(request: Effect.Effect<A, AiError.AiError, R>): Effect.Effect<A, RequestFailed, R> =>
    request.pipe(Effect.mapError((error) => new RequestFailed({ error, request: postedAs(post) })));

/**
 * Marks that the provider has begun to respond to the request being made: a 2xx status arrived.
 * `withRetries` gives each attempt its own; outside it, marking does nothing.
 */
export const ResponseBegan = Context.Reference<{ readonly mark: Effect.Effect<void> }>("agent-session/ResponseBegan", {
  defaultValue: () => ({ mark: Effect.void }),
});

const failure = (caller: Caller, reason: AiError.AiErrorReason): AiError.AiError =>
  AiError.make({ module: caller.module, method: caller.method, reason });

/**
 * The response to `post`. A response that is not 2xx fails with the `AiError`
 * reason for its status, however it arrives: as a response, or, from a client that fails such
 * responses itself (Effect's OpenAI client does), inside a `StatusCodeError`. A 2xx response marks
 * the response as begun (`ResponseBegan`).
 */
const send = (
  http: HttpClient.HttpClient,
  caller: Caller,
  post: Post,
): Effect.Effect<HttpClientResponse.HttpClientResponse, AiError.AiError> =>
  HttpClientRequest.post(post.path).pipe(
    HttpClientRequest.setHeaders(post.headers),
    HttpClientRequest.bodyJsonUnsafe(post.body),
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
        bodyText(caller, response).pipe(
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
    Effect.tap(() =>
      Effect.gen(function* () {
        yield* (yield* ResponseBegan).mark;
      }),
    ),
  );

/** A response whose body did not arrive whole, as a transport error. */
const bodyCut = (caller: Caller, request: HttpClientRequest.HttpClientRequest, description: string, cause?: unknown): AiError.AiError =>
  failure(caller, AiError.NetworkError.fromRequestError(new HttpClientError.TransportError({ request, description, cause })));

/**
 * `HttpClientError` as `AiError`. A body that could not be read to its end (`DecodeError`: the
 * connection closed before the `Content-Length` bytes, or before a chunked body's last chunk,
 * arrived) is a transport error.
 */
const fromHttp =
  (caller: Caller) =>
  (error: HttpClientError.HttpClientError): AiError.AiError => {
    const reason = error.reason;
    switch (reason._tag) {
      case "TransportError":
      case "EncodeError":
      case "InvalidUrlError":
        return failure(caller, AiError.NetworkError.fromRequestError(reason));
      case "DecodeError":
        return bodyCut(caller, reason.request, `The response body could not be read to its end: ${reason.cause instanceof Error ? reason.cause.message : reason.message}`, reason.cause);
      default:
        return failure(caller, new AiError.UnknownError({ description: reason.message }));
    }
  };

const parsed = (caller: Caller, text: string): Effect.Effect<Json, AiError.AiError> =>
  Effect.try({
    try: () => JSON.parse(text) as Json,
    catch: () => failure(caller, new AiError.InvalidOutputError({ description: `The response is not JSON: ${text}` })),
  });

/**
 * The response's body as text. A body whose size is not the response's `Content-Length` fails as a
 * transport error. The header counts the bytes as sent, so it is compared only for a body sent
 * without a `Content-Encoding`: the client decompresses an encoded body before it is read here.
 */
const bodyText = (caller: Caller, response: HttpClientResponse.HttpClientResponse): Effect.Effect<string, AiError.AiError> =>
  response.arrayBuffer.pipe(
    Effect.mapError(fromHttp(caller)),
    Effect.flatMap((bytes) => {
      const declared = response.headers["content-length"];
      const encoding = response.headers["content-encoding"];
      return declared !== undefined && (encoding === undefined || encoding === "identity") && Number(declared) !== bytes.byteLength
        ? Effect.fail(
            bodyCut(caller, response.request, `The response body is ${bytes.byteLength} bytes; its Content-Length says ${declared}`),
          )
        : Effect.succeed(new TextDecoder().decode(bytes));
    }),
  );

/** The response to `post`, parsed as JSON. */
export const postJson = (http: HttpClient.HttpClient, caller: Caller, post: Post): Effect.Effect<Json, AiError.AiError> =>
  send(http, caller, post).pipe(
    Effect.flatMap((response) => bodyText(caller, response)),
    Effect.flatMap((text) => parsed(caller, text)),
  );

/**
 * The response to `post`, as the server-sent events it streams: each event's data, parsed as JSON,
 * as it arrives. A stream is sent chunked, with no `Content-Length`; one closed before its last
 * chunk fails as a transport error. The response had begun, so it is not retried.
 */
export const postEvents = (http: HttpClient.HttpClient, caller: Caller, post: Post): Stream.Stream<Json, AiError.AiError> =>
  send(http, caller, post).pipe(
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
 * Retries `request` while its failure is retryable and came before the provider began to respond
 * (`ResponseBegan`), at most `retries.times` times. A request whose response had begun is not made
 * again: what it passed on, and any tool call it started, belong to that response, and the provider
 * would answer a second request as a new one. The wait before a retry is `firstWait`, doubled each
 * time, or what a rate limit says to wait when it says. Each retry is logged before it is made.
 */
export const withRetries =
  (retries: Retries) =>
  <A>(request: Effect.Effect<A, AiError.AiError>): Effect.Effect<A, AiError.AiError> => {
    const attempt = (retried: number): Effect.Effect<A, AiError.AiError> =>
      Effect.gen(function* () {
        const began = yield* Ref.make(false);
        return yield* request.pipe(
          Effect.provideService(ResponseBegan, { mark: Ref.set(began, true) }),
          Effect.catch((error: AiError.AiError) =>
            Effect.gen(function* () {
              if (!error.reason.isRetryable || retried >= retries.times) return yield* error;
              if (yield* Ref.get(began)) {
                yield* Effect.logWarning(logKeys.provider.notRetried, {
                  reason: error.reason._tag,
                  message: error.message,
                  why: "the provider had begun to respond",
                });
                return yield* error;
              }
              const wait =
                error.reason._tag === "RateLimitError" && error.reason.retryAfter !== undefined
                  ? error.reason.retryAfter
                  : Duration.times(Duration.fromInputUnsafe(retries.firstWait), 2 ** retried);
              yield* Effect.logWarning(logKeys.provider.requestRetried, {
                reason: error.reason._tag,
                message: error.message,
                retry: retried + 1,
                of: retries.times,
                wait: Duration.format(wait),
              });
              yield* Effect.sleep(wait);
              return yield* attempt(retried + 1);
            }),
          ),
        );
      });
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

/** Ends as `ModelFailed` for `turn`, carrying the encoded error and the request, and logs the whole error. */
export const failedAs =
  (turn: TurnId) =>
  ({ error, request }: RequestFailed): Effect.Effect<Extract<Observation, { _tag: "ModelFailed" }>> =>
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
        request,
      }),
    );
