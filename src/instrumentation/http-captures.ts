/**
 * The bodies of each model request's HTTP exchange, written to files and pointed to by a log line.
 *
 * A body is too large for a log line (Loki limits a line's size; a long session's context is
 * hundreds of thousands of tokens), so each one is a file, `<capture_id>.json`, in the folder that
 * `HttpCaptures` names: `http-captures/` beside the log file of the session that made the request.
 * One debug line, `provider.http.payload_captured`, is logged for each file, inside the span that is
 * current when it is written (the model attempt's), so that it carries that span's trace and span
 * ids. Its fields:
 *
 * - `capture_id`: the file's name without `.json`, a UUID (version 7, so that names sort by time);
 * - `body`: which body the file holds (`CapturedBody`);
 * - `body_uri`: the file, as a `file://` URL;
 * - `size`, `sha256`: the file's size in bytes and its SHA-256, in hex;
 * - `redacted`: how many secret values were replaced by `<redacted>` in it. When it is not 0, the
 *   file is no longer exactly what was sent or received.
 *
 * A file is written only when its line will be logged (`Debug` is enabled) and a folder is named, so
 * no file exists without the line that points to it. A file that cannot be written is logged as a
 * warning, and the request goes on.
 *
 * Only the environment's secret values are replaced, as they are in log lines. A credential field's
 * value is not replaced, as it is in log lines, because a body's fields are the provider's: a tool's
 * schema can have a property named `password`, and replacing it would change what the capture says
 * was sent.
 *
 * `capturingHttp` is where the HTTP bodies are taken: the `HttpClient` that every model client is
 * given (`agent-host/clients.ts`). A provider client's own changes to a request (its URL, its key
 * headers) are made before the request reaches it, so the body it records is the body sent. Each
 * `execute` (each attempt, and each retry of it) records its own bodies, all in the span that is
 * current when the request is made:
 *
 * - `request`: the request's body, its bytes as UTF-8, with `method` and `url` (without its query).
 *   No header is recorded, so no key is.
 * - `response_events`: a `text/event-stream` response's text, as a JSON array of its event blocks,
 *   each ending with the blank line that ends it, so that the blocks joined are the text received.
 *   The stream reaches the adapter unchanged; the file is written when it ends, fails or is
 *   interrupted. `complete` is true when the stream ended, or when its last event block is the
 *   Chat Completions end marker (`data: [DONE]` and its blank line): that adapter stops reading
 *   there, which the stream sees as an interruption. It is false when the stream failed or was
 *   interrupted before any end marker (a cancelled request, a connection cut).
 * - `response`: any other response's body, when it is read whole; a body that is not JSON is
 *   recorded as a JSON string, marked `as: "text"`.
 *
 * Response captures also carry `status`, `content_type` and `request_id` (the provider's
 * `request-id` or `x-request-id` header, when it sends one).
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Context, Effect, Exit, Inspectable, Layer, LogLevel, Ref, type Schema, Stream } from "effect";
import type * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import { pipeArguments } from "effect/Pipeable";
import { countingRedactorOf, type Secrets } from "../agent-host/redaction.ts";
import { logKeys } from "../agent-session/log-keys.ts";

/**
 * Which body a capture file holds:
 * - `request`: the request's body, as sent;
 * - `response`: a response's body that was read whole (a JSON answer, or a failed status's body);
 * - `response_events`: a streamed response's server-sent events, as received;
 * - `response_message`: the message that the adapter assembled from the response.
 */
export type CapturedBody = "request" | "response" | "response_events" | "response_message";

/** Where capture files go, and the secret values replaced in them; undefined, the default, writes none. */
export interface CaptureSettings {
  readonly folder: string;
  readonly secrets: Secrets;
}

export const HttpCaptures = Context.Reference<CaptureSettings | undefined>("instrumentation/HttpCaptures", { defaultValue: () => undefined });

/** The capture folder beside a log file's folder. */
export const capturesFolderIn = (logsFolder: string): string => join(logsFolder, "http-captures");

/** The settings captures are written with now: undefined when no folder is named or `Debug` is not enabled. */
const capturing: Effect.Effect<CaptureSettings | undefined> = Effect.gen(function* () {
  const settings = yield* HttpCaptures;
  return settings !== undefined && (yield* LogLevel.isEnabled("Debug")) ? settings : undefined;
});

/**
 * Writes `text`, which is JSON, to a new capture file holding `body`, with the secret values
 * replaced, and logs the line that points to it with `details` added to its fields. Does nothing
 * when no folder is named or `Debug` is not enabled; `text` given as a function is called only when
 * the capture is written, so that a caller pays for making it only then. The file and its line are
 * written together, uninterruptibly: an interruption cannot leave a file that no line points to.
 */
export const captureBody = (body: CapturedBody, text: string | (() => string), details: Readonly<Record<string, unknown>> = {}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const settings = yield* capturing;
    if (settings === undefined) return;
    const redacted = countingRedactorOf(settings.secrets.values)(typeof text === "string" ? text : text());
    const bytes = new TextEncoder().encode(redacted.text);
    const captureId = Bun.randomUUIDv7();
    const file = join(settings.folder, `${captureId}.json`);
    yield* Effect.tryPromise(async () => {
      await mkdir(settings.folder, { recursive: true });
      await Bun.write(file, bytes);
    }).pipe(
      Effect.andThen(
        Effect.logDebug(logKeys.provider.payloadCaptured, {
          ...details,
          capture_id: captureId,
          body,
          body_uri: pathToFileURL(file).href,
          size: bytes.byteLength,
          sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
          redacted: redacted.replaced,
        }),
      ),
      Effect.catch((error) => Effect.logWarning(logKeys.provider.payloadNotCaptured, { body, folder: settings.folder, error })),
      Effect.uninterruptible,
    );
  });

/** A UTF-8 decoder that keeps a leading byte order mark, so that the text is the bytes' whole text. */
const utf8 = () => new TextDecoder("utf-8", { ignoreBOM: true });

/** `text` as a capture holds it: itself when it is JSON; otherwise a JSON string holding it, with `as: "text"`. */
const asJson = (text: string): { readonly text: string; readonly details: Readonly<Record<string, unknown>> } => {
  try {
    JSON.parse(text);
    return { text, details: {} };
  } catch {
    return { text: JSON.stringify(text), details: { as: "text" } };
  }
};

/** A line ending in server-sent events: CRLF, LF or CR. */
const lineEnding = /\r\n|\r|\n/g;

/**
 * Splits server-sent events' text after each blank line, so that each part is one event block with
 * the blank line that ends it, and the parts joined are `text`. Text after the last blank line (an
 * event cut short) is the last part.
 */
export const eventBlocksOf = (text: string): ReadonlyArray<string> => {
  const endings = Array.from(text.matchAll(lineEnding), (ending) => ({ at: ending.index, end: ending.index + ending[0].length }));
  // A line ending that starts where the line before it ended ends a blank line, and so an event block.
  const ends = endings.filter((ending, index) => ending.at === (endings[index - 1]?.end ?? 0)).map((ending) => ending.end);
  const starts = [0, ...ends];
  const blocks = ends.map((end, index) => text.slice(starts[index], end));
  const rest = text.slice(starts.at(-1));
  return rest === "" ? blocks : [...blocks, rest];
};

/** The Chat Completions end marker as an event block: `data: [DONE]` and the blank line after it. */
const doneBlock = /^data: ?\[DONE\](?:\r\n|\r|\n){2}$/;

/** Returns a request body's text: its bytes as UTF-8; or why it is not recorded, for a body that is not bytes. */
const requestText = (body: HttpBody.HttpBody): { readonly text: string } | { readonly notCaptured: string } => {
  switch (body._tag) {
    case "Empty":
      return { text: "" };
    case "Uint8Array":
      return { text: utf8().decode(body.body) };
    case "Raw":
      if (typeof body.body === "string") return { text: body.body };
      if (body.body instanceof Uint8Array || body.body instanceof ArrayBuffer) return { text: utf8().decode(body.body) };
      return { notCaptured: `The request body is a ${Object.prototype.toString.call(body.body)}, which is not recorded.` };
    case "FormData":
    case "Stream":
      return { notCaptured: `The request body is a ${body._tag} body, which is not recorded.` };
    default:
      return body satisfies never;
  }
};

/** The fields of a response's captures: its status, its content type and the provider's request id, when they are sent. */
const responseDetails = (response: HttpClientResponse.HttpClientResponse): Readonly<Record<string, unknown>> => {
  const contentType = response.headers["content-type"];
  const requestId = response.headers["request-id"] ?? response.headers["x-request-id"];
  return {
    status: response.status,
    ...(contentType === undefined ? {} : { content_type: contentType }),
    ...(requestId === undefined ? {} : { request_id: requestId }),
  };
};

type Capture = (body: CapturedBody, text: string, details: Readonly<Record<string, unknown>>) => Effect.Effect<void>;

/**
 * `original`, recording its body as the adapter reads it, once (`captured` says whether it has
 * been): read whole (`arrayBuffer`, `text`, `json`), as `response`; streamed, the bytes pass on as
 * they arrive, and are recorded when the stream ends. `formData` and `urlParamsBody` are not
 * recorded: no provider answers a model request with them.
 */
const capturedResponse = (original: HttpClientResponse.HttpClientResponse, capture: Capture, captured: Ref.Ref<boolean>): HttpClientResponse.HttpClientResponse => {
  const once = (record: Effect.Effect<void>) => Effect.flatMap(Ref.getAndSet(captured, true), (done) => (done ? Effect.void : record));
  const whole = (text: string) =>
    once(
      Effect.suspend(() => {
        const json = asJson(text);
        return capture("response", json.text, json.details);
      }),
    );
  /**
   * Records `text`, the body streamed. `ended` is true when the stream ended rather than failed or
   * was interrupted; an event stream whose last block is the Chat Completions end marker is
   * complete either way, since its adapter stops reading there.
   */
  const streamed = (text: string, ended: boolean) =>
    once(
      Effect.suspend(() => {
        if ((original.headers["content-type"] ?? "").includes("text/event-stream")) {
          const blocks = eventBlocksOf(text);
          return capture("response_events", JSON.stringify(blocks), { complete: ended || doneBlock.test(blocks.at(-1) ?? "") });
        }
        const json = asJson(text);
        return capture("response", json.text, { ...json.details, complete: ended });
      }),
    );
  const response: HttpClientResponse.HttpClientResponse = {
    [HttpIncomingMessage.TypeId]: HttpIncomingMessage.TypeId,
    [HttpClientResponse.TypeId]: HttpClientResponse.TypeId,
    get request() {
      return original.request;
    },
    get url() {
      return original.url;
    },
    get status() {
      return original.status;
    },
    get headers() {
      return original.headers;
    },
    get cookies() {
      return original.cookies;
    },
    get remoteAddress() {
      return original.remoteAddress;
    },
    get formData() {
      return original.formData;
    },
    get urlParamsBody() {
      return original.urlParamsBody;
    },
    get arrayBuffer() {
      return Effect.tap(original.arrayBuffer, (bytes) => whole(utf8().decode(bytes)));
    },
    get text() {
      return Effect.tap(original.text, whole);
    },
    // Parsed as Effect's web response parses its text, from the text recorded.
    get json() {
      return Effect.flatMap(response.text, (read) =>
        Effect.try({
          try: (): Schema.Json => (read === "" ? null : JSON.parse(read)),
          catch: (cause) => new HttpClientError.HttpClientError({ reason: new HttpClientError.DecodeError({ request: original.request, response, cause }) }),
        }),
      );
    },
    get stream() {
      return Stream.unwrap(
        Effect.map(Ref.make(""), (received) => {
          const decoder = utf8();
          return original.stream.pipe(
            Stream.tap((bytes) => Ref.update(received, (sofar) => sofar + decoder.decode(bytes, { stream: true }))),
            Stream.onExit((exit) => Effect.flatMap(Ref.get(received), (sofar) => streamed(sofar + decoder.decode(), Exit.isSuccess(exit)))),
          );
        }),
      );
    },
    toJSON: () => original.toJSON(),
    toString: () => original.toString(),
    [Inspectable.NodeInspectSymbol]: () => original[Inspectable.NodeInspectSymbol](),
    pipe() {
      // oxlint-disable-next-line prefer-rest-params -- `pipeArguments` takes the call's `arguments`, as Effect's own values pass them.
      return pipeArguments(this, arguments);
    },
  };
  return response;
};

/**
 * `client`, recording each request's body and its response's (see the module's description) while
 * captures are written. The request's body is recorded while the request is sent, so that the send
 * does not wait for it; the response is returned once both are done, so no capture outlives the
 * exchange. The request's capture runs to its end even when the send fails or is interrupted first,
 * so that a request that failed fast is still recorded. The response's captures are written with
 * the context of the fiber that made the request, so that a stream read elsewhere is still recorded
 * in the request's span.
 */
export const capturingClient = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.transform(client, (response, request) =>
    Effect.gen(function* () {
      const settings = yield* capturing;
      if (settings === undefined) return yield* response;
      const context = yield* Effect.context<never>();
      // The URL without its query and fragment: a query can carry a key.
      const exchange = { method: request.method, url: request.url.split(/[?#]/, 1)[0] ?? request.url };
      const captureRequest = Effect.suspend(() => {
        const sent = requestText(request.body);
        if (!("text" in sent)) return Effect.logWarning(logKeys.provider.payloadNotCaptured, { body: "request", folder: settings.folder, error: sent.notCaptured });
        const json = asJson(sent.text);
        return captureBody("request", json.text, { ...exchange, ...json.details });
      }).pipe(Effect.uninterruptible);
      // The send first, so that it is under way while the request's body is recorded.
      const [received] = yield* Effect.all([response, captureRequest], { concurrency: 2 });
      const details = { ...exchange, ...responseDetails(received) };
      return capturedResponse(received, (body, text, more) => captureBody(body, text, { ...details, ...more }).pipe(Effect.provideContext(context)), yield* Ref.make(false));
    }),
  );

/** The `HttpClient` of `inner`, recording the bodies of each exchange (`capturingClient`). */
export const capturingHttp = <E, R>(inner: Layer.Layer<HttpClient.HttpClient, E, R>): Layer.Layer<HttpClient.HttpClient, E, R> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      return capturingClient(yield* HttpClient.HttpClient);
    }),
  ).pipe(Layer.provide(inner));
