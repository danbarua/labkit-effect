/**
 * SPIKE: one JSON-RPC 2.0 connection on which this end both serves requests and makes them, built
 * from Effect's `RpcServer` and `RpcClient`. ACP needs this (an agent serves `session/prompt` and,
 * during it, asks the client for permission); so does MCP, where `McpServer` builds the same thing
 * privately.
 *
 * Effect's two RPC halves each speak to one `Protocol`. Here one connection feeds both: an incoming
 * message with a `method` goes to the server, a response goes to the client. Messages are read with
 * Effect's JSON-RPC decoder, which already decodes requests and responses alike, and written by
 * this module, because Effect's encoder speaks its own dialect on the wire: cancellation and
 * acknowledgements as `@effect/rpc/*` notifications, errors carrying the whole `Cause`, requests
 * carrying trace fields. Written here instead:
 *
 * - a cancelled outgoing request is `$/cancel_request { requestId }`, and an incoming one interrupts
 *   the handler, whose response is then the error -32800;
 * - an error is `{ code, message, data? }`: a handler's failure as it gave them, -32800 for an
 *   interruption, -32603 for a defect, always answering the request that died
 *   (`disableFatalDefects`: by default Effect's server reports a handler's defect for the whole
 *   connection, under no request id, and its client then fails every call waiting);
 * - an unknown method is -32601 and params its schema refuses are -32602, answered before any
 *   handler runs; an unknown notification is dropped;
 * - a notification is run by its handler and nothing is sent back.
 */

import { Cause, Effect, Layer, Queue, Schema, Scope, Semaphore, Stream } from "effect";
import { type Rpc, RpcClient, type RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import * as RpcMessage from "effect/rpc/RpcMessage";

/** A JSON-RPC error: what a handler fails with, and what a call to the other end can fail with. */
export const JsonRpcError = Schema.Struct({
  code: Schema.Finite,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
});
export type JsonRpcError = typeof JsonRpcError.Type;

export const cancelMethod = "$/cancel_request";

/** The bytes of one connection: what arrives, and a way to send one encoded message. */
export interface Wire {
  readonly read: Stream.Stream<Uint8Array | string, unknown>;
  readonly write: (line: string) => Effect.Effect<void>;
}

export interface Peer<Call extends Rpc.Any, Notify extends Rpc.Any> {
  /** Requests to the other end, typed by the `call` group. */
  readonly client: RpcClient.RpcClient<Call>;
  /** Sends a notification of the `notify` group: no response is expected. */
  readonly notify: <Tag extends Notify["_tag"]>(
    tag: Tag,
    payload: Rpc.Payload<Rpc.ExtractTag<Notify, Tag>>,
  ) => Effect.Effect<void>;
}

type Encoded = RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded;
type Cause = ReadonlyArray<{ readonly _tag: string; readonly error?: unknown }>;

const codecFor = RpcSerialization.json.codecFor;

/** The JSON codec of an rpc's payload. */
const payloadCodec = (rpc: Rpc.Any) =>
  codecFor((rpc as unknown as Rpc.AnyWithProps).payloadSchema) as unknown as Schema.Codec<unknown, unknown>;

const isJsonRpcError = Schema.is(JsonRpcError);

/** The JSON-RPC error for a handler's encoded failure. */
const errorOf = (cause: Cause): JsonRpcError => {
  const failed = cause.find((reason) => reason._tag === "Fail");
  if (failed !== undefined && isJsonRpcError(failed.error)) return failed.error;
  if (cause.some((reason) => reason._tag === "Interrupt")) return { code: -32800, message: "Request cancelled" };
  return { code: -32603, message: "Internal error" };
};

/**
 * Runs a peer on `wire` until the scope closes. It serves `serve` with the handlers `handlers` builds
 * (given the peer, so a handler can call the other end), calls `call`, and sends `notify`.
 */
export const makePeer = Effect.fnUntraced(function* <
  Serve extends Rpc.Any,
  Call extends Rpc.Any,
  Notify extends Rpc.Any,
  RH,
>(options: {
  readonly wire: Wire;
  readonly serve: RpcGroup.RpcGroup<Serve>;
  readonly call: RpcGroup.RpcGroup<Call>;
  readonly notify: RpcGroup.RpcGroup<Notify>;
  readonly handlers: (peer: Peer<Call, Notify>) => Layer.Layer<Rpc.ToHandler<Serve>, never, RH>;
}) {
  const scope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const send = (message: object) => lock.withPermit(options.wire.write(`${JSON.stringify(message)}\n`));
  // Incoming notifications are run as requests under ids of their own, and their responses dropped.
  const notificationIds = new Set<string | number>();
  let notificationCount = 0;

  // The server half: what it sends is a response to the other end's request.
  let toServer!: (clientId: number, message: RpcMessage.FromClientEncoded) => Effect.Effect<void>;
  const disconnects = yield* Queue.make<number>();
  const serverProtocol = yield* RpcServer.Protocol.make((write) => {
    toServer = write;
    return Effect.succeed({
      disconnects,
      send: (_clientId: number, response: RpcMessage.FromServerEncoded) => {
        switch (response._tag) {
          case "Exit": {
            if (notificationIds.delete(response.requestId)) return Effect.void;
            return response.exit._tag === "Success"
              ? send({ jsonrpc: "2.0", id: response.requestId, result: response.exit.value ?? null })
              : send({ jsonrpc: "2.0", id: response.requestId, error: errorOf(response.exit.cause as Cause) });
          }
          case "Defect":
            return send({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
          default:
            return Effect.void;
        }
      },
      end: () => Effect.void,
      clientIds: Effect.succeed(new Set([0])),
      initialMessage: Effect.succeedNone,
      supportsAck: false,
      supportsTransferables: false,
      supportsSpanPropagation: false,
      supportsNotifications: true,
      codecFor,
    });
  });

  // The client half: what it sends is a request to the other end, or the cancellation of one.
  let toClient!: (clientId: number, message: RpcMessage.FromServerEncoded) => Effect.Effect<void>;
  let clientId = 0;
  const clientProtocol = yield* RpcClient.Protocol.make((write) => {
    toClient = write;
    return Effect.succeed({
      send: (id: number, request: RpcMessage.FromClientEncoded) => {
        clientId = id;
        switch (request._tag) {
          case "Request":
            return send({ jsonrpc: "2.0", id: request.id, method: request.tag, params: request.payload });
          case "Interrupt":
            return send({ jsonrpc: "2.0", method: cancelMethod, params: { requestId: request.requestId } });
          default:
            return Effect.void;
        }
      },
      supportsAck: false,
      supportsTransferables: false,
      codecFor,
    });
  });

  const client = yield* RpcClient.make(options.call, { disableTracing: true }).pipe(
    Effect.provideService(RpcClient.Protocol, clientProtocol),
  );
  const notify: Peer<Call, Notify>["notify"] = (tag, payload) =>
    Schema.encodeUnknownEffect(payloadCodec(options.notify.requests.get(tag)!))(payload).pipe(
      Effect.orDie,
      Effect.flatMap((params) => send({ jsonrpc: "2.0", method: tag, params })),
    );
  const peer: Peer<Call, Notify> = { client, notify };

  yield* RpcServer.make(options.serve, { disableTracing: true, disableFatalDefects: true }).pipe(
    Effect.provideService(RpcServer.Protocol, serverProtocol),
    Effect.provide(options.handlers(peer)),
    Effect.forkIn(scope),
  );

  const refuse = (id: unknown, error: JsonRpcError) => send({ jsonrpc: "2.0", id, error });

  /** Hands one incoming message to the half it is for. */
  const route = (message: Encoded): Effect.Effect<void, never, RH> => {
    switch (message._tag) {
      case "Request": {
        if (message.tag === cancelMethod) {
          const requestId = (message.payload as { readonly requestId?: unknown } | null)?.requestId;
          if (typeof requestId !== "string" && typeof requestId !== "number") return Effect.void;
          // The request may have ended already; then there is nothing to cancel.
          return toServer(0, { _tag: "Interrupt", requestId: RpcMessage.RequestId(requestId) }).pipe(Effect.ignore);
        }
        const rpc = options.serve.requests.get(message.tag);
        if (rpc === undefined)
          return message.isNotification
            ? Effect.void
            : refuse(message.id, { code: -32601, message: `Method not found: ${message.tag}` });
        return Schema.decodeUnknownEffect(payloadCodec(rpc))(message.payload).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              message.isNotification
                ? Effect.void
                : refuse(message.id, { code: -32602, message: "Invalid params", data: String(error) }),
            onSuccess: () => {
              if (!message.isNotification) return toServer(0, message);
              const id = `notification/${notificationCount++}`;
              notificationIds.add(id);
              return toServer(0, { ...message, id: RpcMessage.RequestId(id) });
            },
          }),
        );
      }
      case "Exit":
      case "Chunk":
        return toClient(clientId, message);
      default:
        return Effect.void;
    }
  };

  const parser = RpcSerialization.ndJsonRpc().makeUnsafe();
  yield* options.wire.read.pipe(
    Stream.runForEach((chunk) => Effect.forEach(parser.decode(chunk) as ReadonlyArray<Encoded>, route, { discard: true })),
    Effect.catchCause((cause) => Effect.logError("json-rpc-peer: the connection failed", Cause.pretty(cause))),
    Effect.forkIn(scope),
  );

  return peer;
});
