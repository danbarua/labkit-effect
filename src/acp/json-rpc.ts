/**
 * JSON-RPC 2.0 as ACP uses it, and the wire one ACP connection runs over.
 *
 * A wire carries whole JSON-RPC messages, already parsed: framing (newline-delimited JSON over
 * stdio, POST bodies and server-sent events over HTTP) is the wire's business, and what the
 * messages mean is the peer's. A message the wire could not parse arrives as `Unparsable`, so the
 * peer can answer it with a parse error.
 */

import { Data, type Effect, Schema, type Stream } from "effect";

/** A request's id: a string or a number. `null` appears only in an error response to a message whose id could not be read. */
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
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcError;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

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
