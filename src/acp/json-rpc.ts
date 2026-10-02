/**
 * JSON-RPC 2.0 as ACP uses it, and the wire one ACP connection runs over.
 *
 * A wire carries whole JSON-RPC messages, already parsed: framing (newline-delimited JSON over
 * stdio, POST bodies and server-sent events over HTTP) is the wire's business, and what the
 * messages mean is the peer's. A message the wire could not parse arrives as `Unparsable`, so the
 * peer can answer it with a parse error.
 */

import { Data, type Effect, Predicate, Schema, type Stream } from "effect";

/**
 * A request's id: a string or a number. A response carries `null` instead when the request's id was
 * `null` or could not be read.
 */
export type JsonRpcId = string | number;

/** The error codes ACP names (JSON-RPC's own, and ACP's in the reserved range). */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  RequestCancelled: -32800,
  AuthRequired: -32000,
  ResourceNotFound: -32002,
} as const;

/** A JSON-RPC error: what a handler fails with, and what a call to the other end fails with when it answers with an error. */
export const JsonRpcError = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
});
export type JsonRpcError = typeof JsonRpcError.Type;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcError;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** An id as a message may carry it: a string, a finite number, or `null`. */
export const isJsonRpcId = (value: unknown): value is JsonRpcId | null =>
  value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

/** A request: an object with a `method` and an `id`, neither of them checked further. */
export const isRequest = (value: unknown): value is { readonly [key: string]: unknown; readonly id: unknown } =>
  Predicate.isObject(value) && "id" in value && "method" in value;

/**
 * A response as the ACP SDK decides it: an object with `jsonrpc: "2.0"`, no `method`, an id
 * `isJsonRpcId` accepts, and exactly one own `result` or `error`, an error having an integer `code`
 * and a string `message`.
 */
export const isResponse = (value: unknown): value is { readonly [key: string]: unknown; readonly id: JsonRpcId | null } => {
  if (!Predicate.isObject(value) || value["jsonrpc"] !== "2.0" || "method" in value) return false;
  if (!("id" in value) || !isJsonRpcId(value["id"])) return false;
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) return false;
  const error = value["error"];
  return !hasError || (Predicate.isObject(error) && Number.isInteger(error["code"]) && typeof error["message"] === "string");
};

/**
 * Shaped like a response, well formed or not: an object with no `method` and a `result` or an
 * `error`. Its `id`, if it is one `isJsonRpcId` accepts, is the id of a request the reader sent.
 */
export const isResponseShaped = (value: unknown): value is { readonly [key: string]: unknown } =>
  Predicate.isObject(value) && !("method" in value) && ("result" in value || "error" in value);

/** What a wire delivers: one parsed JSON value (a message, or a batch of them), or text it could not parse. */
export type WireInput = Data.TaggedEnum<{
  Json: { readonly value: unknown };
  Unparsable: { readonly text: string };
}>;
export const WireInput = Data.taggedEnum<WireInput>();

/** The wire failed: it could not be read, or a message could not be written. */
export class WireError extends Data.TaggedError("WireError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/**
 * One connection's messages. `read` ends when the other end closes the connection; `write` sends
 * one message, or a batch's responses as one array.
 */
export interface Wire {
  readonly read: Stream.Stream<WireInput, WireError>;
  readonly write: (message: JsonRpcMessage | ReadonlyArray<JsonRpcMessage>) => Effect.Effect<void, WireError>;
}
