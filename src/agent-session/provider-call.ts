/**
 * What every provider adapter does around one model request: post JSON through the provider's
 * configured HTTP client, fail with Effect's `AiError` when the request does not produce a usable
 * response, retry the failures `AiError` marks retryable that come before a response begins, and
 * end as `ModelFailed` otherwise, carrying the error and the request as it was posted. The whole
 * error is logged where it is caught.
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
import { ModelClient, type ProviderRequest } from "./contracts.ts";
import { receivedJson } from "./received.ts";
import { logKeys } from "./log-keys.ts";

type Json = Schema.Json;

/** Which adapter made the request, as `AiError` records it. */
export interface Caller {
  readonly module: string;
  readonly method: string;
}

/**
 * How a request is retried: how many times at most; the first wait, which doubles each time; and the
 * longest a rate limit's wait may be for it to be waited out (1 minute unless given). A rate limit
 * that says to wait longer (a usage window that resets in hours) is not waited for: its failure goes
 * to the turn at once, with the wait it said.
 */
export interface Retries {
  readonly times: number;
  readonly firstWait: Duration.Input;
  readonly longestWait?: Duration.Input;
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
              failure(caller, reasonOf(response.status, response.headers["retry-after"], `HTTP ${response.status}: ${text}`)),
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

/**
 * The reason for a failed status: Effect's, with the wait a rate limit says (`Retry-After`, as
 * seconds or as a date), which `reasonFromHttpStatus` does not read.
 */
const reasonOf = (status: number, retryAfter: string | undefined, description: string): AiError.AiErrorReason => {
  const reason = AiError.reasonFromHttpStatus({ status, description });
  if (reason._tag !== "RateLimitError" || retryAfter === undefined) return reason;
  const seconds = Number(retryAfter.trim());
  const millis = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
  return Number.isFinite(millis) && millis >= 0 ? new AiError.RateLimitError({ retryAfter: Duration.millis(millis) }) : reason;
};

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

/** A response's server-sent events: each event's data, parsed as JSON, as it arrives. */
/**
 * How long a response's stream may send nothing, not a byte, before the request fails: the
 * connection has gone quiet. A server's keep-alive comments count as something.
 */
export const ModelStreamIdle = Context.Reference<Duration.Input>("agent-session/ModelStreamIdle", { defaultValue: () => "10 minutes" });

const eventsOf = (caller: Caller, response: HttpClientResponse.HttpClientResponse): Stream.Stream<Json, AiError.AiError> =>
  Stream.unwrap(Effect.map(ModelStreamIdle, (idle) => quietFails(caller, response, idle)));

/** `response`'s events, failing if its bytes stop for `idle`. */
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
 * The response to `post`, as the server-sent events it streams: each event's data, parsed as JSON,
 * as it arrives. A stream is sent chunked, with no `Content-Length`; one closed before its last
 * chunk fails as a transport error. The response had begun, so it is not retried.
 */
export const postEvents = (http: HttpClient.HttpClient, caller: Caller, post: Post): Stream.Stream<Json, AiError.AiError> =>
  send(http, caller, post).pipe(
    Effect.map((response) => eventsOf(caller, response)),
    Stream.unwrap,
  );

/**
 * As `postEvents`, from a server that may answer a request to stream with the whole response
 * instead: a response that is not `text/event-stream` is read whole, as JSON, and is the one event.
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

/** Fails with the response's text, when a provider's response does not have the shape expected. */
export const invalidOutput = (caller: Caller, description: string): AiError.AiError =>
  failure(caller, new AiError.InvalidOutputError({ description }));

/** A request's failure, and whether the provider had begun to respond when it came. */
interface Attempted {
  readonly error: AiError.AiError;
  readonly began: boolean;
}

/**
 * When a failed request is made again: while its failure is retryable, came before the provider
 * began to respond, and `retries.times` are not used up; after `firstWait`, doubled each time, or
 * what a rate limit says to wait when it says. Each retry is logged before its wait, and a retryable
 * failure that came after the response began is logged as not retried.
 */
/** Why a retryable failure is not retried, if it is not: the provider had begun to respond, or a rate limit says to wait longer than `longest`. */
const notRetriedBecause = (began: boolean, reason: AiError.AiErrorReason, longest: Duration.Duration): string | undefined => {
  if (began) return "the provider had begun to respond";
  if (reason._tag === "RateLimitError" && reason.retryAfter !== undefined && Duration.isGreaterThan(Duration.fromInputUnsafe(reason.retryAfter), longest))
    return `the rate limit's wait, ${Duration.format(Duration.fromInputUnsafe(reason.retryAfter))}, is longer than ${Duration.format(longest)}`;
  return undefined;
};

const retrying = (retries: Retries) =>
  Schedule.exponential(retries.firstWait).pipe(
    Schedule.while(({ input, attempt }: Schedule.Metadata<Duration.Duration, Attempted>) =>
      Effect.gen(function* () {
        const reason = input.error.reason;
        if (!reason.isRetryable || attempt > retries.times) return false;
        const longest = Duration.fromInputUnsafe(retries.longestWait ?? "1 minute");
        const why = notRetriedBecause(input.began, reason, longest);
        if (why === undefined) return true;
        yield* Effect.logWarning(logKeys.provider.notRetried, { reason: reason._tag, message: input.error.message, why });
        return false;
      }),
    ),
    Schedule.modifyDelay(({ input, attempt, duration }: Schedule.Metadata<Duration.Duration, Attempted>) =>
      Effect.gen(function* () {
        const reason = input.error.reason;
        const wait = reason._tag === "RateLimitError" && reason.retryAfter !== undefined ? Duration.fromInputUnsafe(reason.retryAfter) : duration;
        yield* Effect.logWarning(logKeys.provider.requestRetried, {
          reason: reason._tag,
          message: input.error.message,
          retry: attempt,
          of: retries.times,
          wait: Duration.format(wait),
        });
        return wait;
      }),
    ),
  );

/**
 * Retries `request` as `retrying` says. A request whose response had begun is not made again: what
 * it passed on, and any tool call it started, belong to that response, and the provider would answer
 * a second request as a new one. Each attempt has its own mark of the response beginning
 * (`ResponseBegan`).
 */
export const withRetries =
  (retries: Retries) =>
  <A>(request: Effect.Effect<A, AiError.AiError>): Effect.Effect<A, AiError.AiError> =>
    Effect.gen(function* () {
      const began = yield* Ref.make(false);
      return yield* request.pipe(
        Effect.provideService(ResponseBegan, { mark: Ref.set(began, true) }),
        Effect.catch((error: AiError.AiError) => Effect.flatMap(Ref.get(began), (wasBegun) => Effect.fail<Attempted>({ error, began: wasBegun }))),
      );
    }).pipe(
      Effect.retry(retrying(retries)),
      Effect.mapError(({ error }) => error),
    );

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
