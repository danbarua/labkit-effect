/**
 * What every provider adapter does around one model request:
 * - post JSON through the provider's configured HTTP client;
 * - fail with Effect's `AiError` when the request does not produce a usable response;
 * - decide which failures are retried: those that `AiError` marks retryable and that come before a
 *   response begins (`retryMade`, `retryWait`). A model client retries a model request's send
 *   (`model-fallback.ts`); `withRetries` retries a count of tokens or a compaction;
 * - otherwise end as `ModelFailed`, carrying the error and the request as it was posted.
 *
 * The whole error is logged where it is caught.
 */

import { Context, Data, Duration, Effect, Ref, Schedule, Schema, Stream } from "effect";
import * as Sse from "effect/encoding/Sse";
import * as AiError from "effect/ai/AiError";
import type * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FailureText, type TurnId } from "../agent-machine/names.ts";
import type { Observation } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";
import { receivedJson } from "./received.ts";
import { logKeys } from "./log-keys.ts";

type Json = Schema.Json;

/** Which adapter made the request, as `AiError` records it. */
export interface Caller {
  readonly module: string;
  readonly method: string;
}

/**
 * How a request is retried: the maximum number of retries; the first wait, which doubles each time;
 * and the longest rate-limit wait that is waited out (1 minute unless given). A rate limit that asks
 * for a longer wait (a usage window that resets in hours) is not waited for: its failure goes to the
 * turn at once, with the wait it asked for.
 */
export interface Retries {
  readonly times: number;
  readonly firstWait: Duration.Input;
  readonly longestWait?: Duration.Input;
}

export const defaultRetries: Retries = { times: 3, firstWait: "500 millis" };

/**
 * A request as it is posted: the path, the headers that the adapter sets, and the body. The client's
 * own headers (the key, the API version) are set by the configured client and are not included.
 */
export interface Post {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Json;
}

/** Returns `post` as it is recorded with a failure. */
export const postedAs = (post: Post): Received => receivedJson({ path: post.path, headers: post.headers, body: post.body });

/**
 * A request that failed after its retries were used up: the error, and the request as the model
 * client made it (`postedAs` for an adapter that posts over HTTP).
 */
export class RequestFailed extends Data.TaggedError("RequestFailed")<{
  readonly error: AiError.AiError;
  readonly request: Received;
}> {}

/** Runs `request`; when it fails with an `AiError`, fails with `RequestFailed`, carrying `post`. */
export const failedPosting =
  (post: Post) =>
  <A, R>(request: Effect.Effect<A, AiError.AiError, R>): Effect.Effect<A, RequestFailed, R> =>
    request.pipe(Effect.mapError((error) => new RequestFailed({ error, request: postedAs(post) })));

/**
 * Marks that the provider has begun to respond to the request being made: a 2xx status arrived.
 * `markingBegan` gives each attempt its own mark; outside it, marking does nothing.
 */
export const ResponseBegan = Context.Reference<{ readonly mark: Effect.Effect<void> }>("agent-session/ResponseBegan", {
  defaultValue: () => ({ mark: Effect.void }),
});

/**
 * Keeps the status of the last HTTP response of the attempt being made, when it was not 2xx, for the
 * attempt's span: a failure's reason, such as a rate limit, does not keep it. A 2xx response clears
 * it. The model attempt's observer (`instrumentation/model-attempts.ts`) gives each attempt, each try
 * of a send, its own; outside one, nothing is kept.
 */
export const FailedStatus = Context.Reference<Ref.Ref<number | undefined> | undefined>("agent-session/FailedStatus", { defaultValue: () => undefined });

/** Keeps `status` as the attempt's last status (`FailedStatus`), when the attempt keeps one. */
const keepStatus = (status: number | undefined) =>
  Effect.gen(function* () {
    const kept = yield* FailedStatus;
    if (kept !== undefined) yield* Ref.set(kept, status);
  });

const failure = (caller: Caller, reason: AiError.AiErrorReason): AiError.AiError =>
  AiError.make({ module: caller.module, method: caller.method, reason });

/**
 * Posts `post` and returns the response. A response that is not 2xx fails with the `AiError` reason
 * for its status, whether it arrives as a response or, from a client that fails such responses
 * itself (Effect's OpenAI client does), inside a `StatusCodeError`, and its status is kept
 * (`FailedStatus`). A 2xx response clears the status kept, and marks the response as begun
 * (`ResponseBegan`).
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
        keepStatus(response.status).pipe(
          Effect.andThen(bodyText(caller, response)),
          Effect.flatMap((text) =>
            Effect.fail(
              failure(caller, reasonOf(response.status, response.headers["retry-after"], `HTTP ${response.status}: ${text}`)),
            ),
          ),
        ),
    ),
    Effect.tap(() =>
      Effect.gen(function* () {
        yield* keepStatus(undefined);
        yield* (yield* ResponseBegan).mark;
      }),
    ),
  );

/**
 * Returns the reason for a failed status: Effect's reason, with the wait that a rate limit asks for
 * (`Retry-After`, as seconds or as a date), which `reasonFromHttpStatus` does not read.
 */
const reasonOf = (status: number, retryAfter: string | undefined, description: string): AiError.AiErrorReason => {
  const reason = AiError.reasonFromHttpStatus({ status, description });
  if (reason._tag !== "RateLimitError" || retryAfter === undefined) return reason;
  const seconds = Number(retryAfter.trim());
  const millis = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
  return Number.isFinite(millis) && millis >= 0 ? new AiError.RateLimitError({ retryAfter: Duration.millis(millis) }) : reason;
};

/** Returns a transport error for a response whose body did not arrive whole. */
const bodyCut = (caller: Caller, request: HttpClientRequest.HttpClientRequest, description: string, cause?: unknown): AiError.AiError =>
  failure(caller, AiError.NetworkError.fromRequestError(new HttpClientError.TransportError({ request, description, cause })));

/**
 * Converts an `HttpClientError` to an `AiError`. A body that could not be read to its end
 * (`DecodeError`: the connection closed before the `Content-Length` bytes, or before a chunked
 * body's last chunk, arrived) is a transport error.
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
      case "EmptyBodyError":
      case "StatusCodeError":
        return failure(caller, new AiError.UnknownError({ description: reason.message }));
      default:
        return reason satisfies never;
    }
  };

const parsed = (caller: Caller, text: string): Effect.Effect<Json, AiError.AiError> =>
  Effect.try({
    try: () => JSON.parse(text) as Json,
    catch: () => failure(caller, new AiError.InvalidOutputError({ description: `The response is not JSON: ${text}` })),
  });

/**
 * Returns the response's body as text. A body whose size differs from the response's
 * `Content-Length` fails as a transport error. The header counts the bytes as sent, so it is compared
 * only for a body sent without a `Content-Encoding`: the client decompresses an encoded body before
 * it is read here.
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

/** Posts `post` and returns the response, parsed as JSON. */
export const postJson = (http: HttpClient.HttpClient, caller: Caller, post: Post): Effect.Effect<Json, AiError.AiError> =>
  send(http, caller, post).pipe(
    Effect.flatMap((response) => bodyText(caller, response)),
    Effect.flatMap((text) => parsed(caller, text)),
  );

/**
 * How long a response's stream may send no bytes before the request fails, because the connection
 * has gone quiet. A server's keep-alive comments count as bytes.
 */
export const ModelStreamIdle = Context.Reference<Duration.Input>("agent-session/ModelStreamIdle", { defaultValue: () => "10 minutes" });

/** Returns a response's server-sent events: each event's data, parsed as JSON, as it arrives. */
const eventsOf = (caller: Caller, response: HttpClientResponse.HttpClientResponse): Stream.Stream<Json, AiError.AiError> =>
  Stream.unwrap(Effect.map(ModelStreamIdle, (idle) => quietFails(caller, response, idle)));

/** Returns `response`'s events; the stream fails when no bytes arrive for `idle`. */
const quietFails = (caller: Caller, response: HttpClientResponse.HttpClientResponse, idle: Duration.Input): Stream.Stream<Json, AiError.AiError> =>
  response.stream.pipe(
    Stream.timeoutOrElse({
      duration: idle,
      orElse: () =>
        Stream.fail(bodyCut(caller, response.request, `The response's stream sent nothing for ${Duration.format(Duration.fromInputUnsafe(idle))}`)),
    }),
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.mapError((error) => {
      if (AiError.isAiError(error)) return error;
      switch (error._tag) {
        case "Retry":
          return failure(caller, new AiError.UnknownError({ description: "The event stream asked to be retried" }));
        case "SseError":
          return failure(caller, new AiError.InvalidOutputError({ description: `The event stream could not be read: ${error.message}` }));
        case "HttpClientError":
          return fromHttp(caller)(error);
        default:
          return error satisfies never;
      }
    }),
    // Chat Completions ends its stream with a `[DONE]` that is not JSON.
    Stream.takeWhile((event) => event.data !== "[DONE]"),
    Stream.mapEffect((event) => parsed(caller, event.data)),
  );

/**
 * Posts `post` and returns the server-sent events that the response streams: each event's data,
 * parsed as JSON, as it arrives. A stream is sent chunked, with no `Content-Length`; a stream closed
 * before its last chunk fails as a transport error, and is not retried, because the response had
 * begun.
 */
export const postEvents = (http: HttpClient.HttpClient, caller: Caller, post: Post): Stream.Stream<Json, AiError.AiError> =>
  send(http, caller, post).pipe(
    Effect.map((response) => eventsOf(caller, response)),
    Stream.unwrap,
  );

/**
 * As `postEvents`, for a server that may answer a streaming request with the whole response instead:
 * a response that is not `text/event-stream` is read whole, as JSON, and returned as the one event.
 */
export const postEventsOrWhole = (http: HttpClient.HttpClient, caller: Caller, post: Post): Stream.Stream<Json, AiError.AiError> =>
  send(http, caller, post).pipe(
    Effect.map((response) =>
      (response.headers["content-type"] ?? "").includes("text/event-stream")
        ? eventsOf(caller, response)
        : Stream.fromEffect(bodyText(caller, response).pipe(Effect.flatMap((text) => parsed(caller, text)))),
    ),
    Stream.unwrap,
  );

/** Returns an invalid-output error carrying `description`, for a provider response that does not have the expected shape. */
export const invalidOutput = (caller: Caller, description: string): AiError.AiError =>
  failure(caller, new AiError.InvalidOutputError({ description }));

/** A request's failure, and whether the provider had begun to respond when it came. */
export interface Began<E> {
  readonly failed: E;
  readonly began: boolean;
}

/**
 * Runs `request` with its own mark of the response beginning (`ResponseBegan`). When `request`
 * fails, the failure carries whether the provider had begun to respond.
 */
export const markingBegan = <A, E, R>(request: Effect.Effect<A, E, R>): Effect.Effect<A, Began<E>, R> =>
  Effect.gen(function* () {
    const began = yield* Ref.make(false);
    return yield* request.pipe(
      Effect.provideService(ResponseBegan, { mark: Ref.set(began, true) }),
      Effect.catch((failed: E) => Effect.flatMap(Ref.get(began), (wasBegun) => Effect.fail<Began<E>>({ failed, began: wasBegun }))),
    );
  });

/** Returns why a retryable failure is not retried, or undefined when it is: the provider had begun to respond, or a rate limit asks for a wait longer than `longest`. */
const notRetriedBecause = (began: boolean, reason: AiError.AiErrorReason, longest: Duration.Duration): string | undefined => {
  if (began) return "the provider had begun to respond";
  if (reason._tag === "RateLimitError" && reason.retryAfter !== undefined && Duration.isGreaterThan(Duration.fromInputUnsafe(reason.retryAfter), longest))
    return `the rate limit's wait, ${Duration.format(Duration.fromInputUnsafe(reason.retryAfter))}, is longer than ${Duration.format(longest)}`;
  return undefined;
};

/**
 * Returns whether retry `retry` (1 for the first) is made after a request failed with `error`. It is
 * made while all of these hold:
 * - the failure is retryable;
 * - it came before the provider began to respond (`began`);
 * - `retries.times` are not used up.
 *
 * A retryable failure that is not retried for another reason is logged as a warning with the reason.
 */
export const retryMade = (retries: Retries, { failed: error, began }: Began<AiError.AiError>, retry: number): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const reason = error.reason;
    if (!reason.isRetryable || retry > retries.times) return false;
    const longest = Duration.fromInputUnsafe(retries.longestWait ?? "1 minute");
    const why = notRetriedBecause(began, reason, longest);
    if (why === undefined) return true;
    yield* Effect.logWarning(logKeys.provider.notRetried, { reason: reason._tag, message: error.message, why, error: encodeAiError(error) });
    return false;
  });

/**
 * Returns the wait before retry `retry` (1 for the first) after a request failed with `error`: the
 * wait that a rate limit asks for, or `firstWait` doubled for each retry before this one. The retry is
 * logged as a warning before its wait.
 */
export const retryWait = (retries: Retries, error: AiError.AiError, retry: number): Effect.Effect<Duration.Duration> =>
  Effect.gen(function* () {
    const reason = error.reason;
    const wait =
      reason._tag === "RateLimitError" && reason.retryAfter !== undefined
        ? Duration.fromInputUnsafe(reason.retryAfter)
        : Duration.times(Duration.fromInputUnsafe(retries.firstWait), 2 ** (retry - 1));
    yield* Effect.logWarning(logKeys.provider.requestRetried, {
      reason: reason._tag,
      message: error.message,
      retry,
      of: retries.times,
      wait: Duration.format(wait),
      error: encodeAiError(error),
    });
    return wait;
  });

/** The retry schedule of `withRetries`: a retry is made when `retryMade` says so, after `retryWait`. */
const retrying = (retries: Retries) =>
  Schedule.forever.pipe(
    Schedule.while(({ input, attempt }: Schedule.Metadata<number, Began<AiError.AiError>>) => retryMade(retries, input, attempt)),
    Schedule.modifyDelay(({ input, attempt }: Schedule.Metadata<number, Began<AiError.AiError>>) => retryWait(retries, input.failed, attempt)),
  );

/**
 * Retries `request` on the `retrying` schedule, for a request that is not a model request: a count of
 * tokens, or a compaction. (A model client retries a model request's send itself,
 * `model-fallback.ts`.) A request whose response had begun is not made again: what it passed on, and
 * any tool call it started, belong to that response, and the provider would answer a second request
 * as a new one. Each attempt has its own mark of the response beginning (`ResponseBegan`).
 */
export const withRetries =
  (retries: Retries) =>
  <A>(request: Effect.Effect<A, AiError.AiError>): Effect.Effect<A, AiError.AiError> =>
    markingBegan(request).pipe(
      Effect.retry(retrying(retries)),
      Effect.mapError(({ failed }) => failed),
    );

const encodeAiError = Schema.encodeSync(Schema.toCodecJson(AiError.AiError));

/** Encodes the error as JSON, in `AiError`'s own encoding, which decodes back to the same error. */
export const receivedAiError = (error: AiError.AiError): Received => receivedJson(encodeAiError(error) as Json);

/** Returns `ModelFailed` for `turn`, carrying the encoded error and the request, and logs the whole error. */
export const failedAs =
  (turn: TurnId) =>
  ({ error, request }: RequestFailed): Effect.Effect<Extract<Observation, { _tag: "ModelFailed" }>> =>
    Effect.logError(logKeys.provider.requestFailed, {
      reason: error.reason._tag,
      retryable: error.reason.isRetryable,
      message: error.message,
      module: error.module,
      method: error.method,
      error: encodeAiError(error),
    }).pipe(
      Effect.as({
        _tag: "ModelFailed" as const,
        turn,
        failure: FailureText.make(error.message),
        error: receivedAiError(error),
        request,
      }),
    );
