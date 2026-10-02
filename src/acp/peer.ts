/**
 * One JSON-RPC 2.0 connection on which this end both serves requests and makes them, built from
 * Effect's `RpcServer` and `RpcClient`. ACP needs this: an agent serves `session/prompt` and, during
 * it, asks the client for permission.
 *
 * Effect's two RPC halves each speak to one `Protocol`. Here one wire feeds both: an incoming
 * request or notification goes to the server half, a response goes to the client half. This module
 * writes every message itself, because Effect's own encoders speak their own dialect
 * (`@effect/rpc/*` control messages, errors carrying the whole `Cause`, trace fields):
 *
 * - a cancelled outgoing request is `$/cancel_request { requestId }`, and an incoming one interrupts
 *   the handler, whose response is then the error -32800;
 * - a handler's failure goes out as the `JsonRpcError` it failed with, an interruption as -32800, a
 *   defect as -32603, always answering the request that died (`disableFatalDefects`: by default
 *   Effect's server reports a handler's defect for the whole connection, under no request id);
 * - an unknown method is -32601 and params its schema refuses are -32602, answered before any
 *   handler runs, because `RpcServer` turns both into defects; an unknown notification, or one whose
 *   params are refused, is dropped;
 * - a notification is run by its handler and nothing is sent back;
 * - a `null` result for a request whose success schema refuses `null` and accepts `{}` reaches the
 *   caller as `{}`, as the ACP SDK reads it: the SDK answers `null` when a handler returns nothing;
 * - a malformed response is answered -32600 under id null, and the pending call whose id it
 *   carries fails with the `JsonRpcError` -32600 "The response to this request is malformed".
 *
 * Incoming requests reach the server half under private ids, so any JSON-RPC id (`null` included)
 * can be answered, notifications can run as requests whose responses are dropped, and a batch's
 * responses can be gathered into one array.
 */

import { Deferred, Effect, Exit, Fiber, type Layer, Predicate, Queue, Schema, Scope, Semaphore, Stream } from "effect";
import { type Rpc, RpcClient, RpcClientError, type RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import {
  ErrorCode,
  isJsonRpcId,
  isResponseShaped,
  JsonRpcError,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type Wire,
  type WireInput,
} from "./json-rpc.ts";

/** The method of the notification that cancels a request, in either direction. */
export const cancelMethod = "$/cancel_request";

export interface Peer<Call extends Rpc.Any, Notify extends Rpc.Any> {
  /**
   * Requests to the other end, typed by the `call` group. A call fails with the rpc's declared error
   * when the other end answers with an error, and with `RpcClientError` when the connection closes
   * before it is answered or the request cannot be written.
   */
  readonly client: RpcClient.RpcClient<Call, RpcClientError.RpcClientError>;
  /** Sends a notification of the `notify` group. Nothing is sent once the connection has closed. */
  readonly notify: <Tag extends Notify["_tag"]>(
    tag: Tag,
    payload: Rpc.Payload<Rpc.ExtractTag<Notify, Tag>>,
  ) => Effect.Effect<void>;
  /** Completes when the wire's `read` ends or fails, or the peer's scope closes. */
  readonly closed: Effect.Effect<void>;
}

/** A batch's responses, written as one array once every request in it is answered. */
interface Batch {
  expected: number;
  sealed: boolean;
  readonly responses: Array<JsonRpcResponse>;
}

/** Where the answer to an incoming request goes. */
interface Incoming {
  readonly id: JsonRpcId | null;
  readonly batch: Batch | undefined;
}

/** One incoming JSON value, as far as JSON-RPC 2.0 is concerned. */
type Classified =
  | { readonly _tag: "Request"; readonly id: JsonRpcId | null; readonly method: string; readonly params: unknown }
  | { readonly _tag: "Notification"; readonly method: string; readonly params: unknown }
  | { readonly _tag: "Success"; readonly id: JsonRpcId | null; readonly result: unknown }
  | { readonly _tag: "Failure"; readonly id: JsonRpcId | null; readonly error: JsonRpcError }
  | { readonly _tag: "Invalid"; readonly id: JsonRpcId | null }
  /** A malformed response; `id` is the one it carries, when it carries one. */
  | { readonly _tag: "MalformedResponse"; readonly id: JsonRpcId | null };

type EncodedCause = ReadonlyArray<{ readonly _tag: string; readonly error?: unknown }>;

const codecFor = RpcSerialization.json.codecFor;

/** The JSON codec of an rpc's payload or success, as `RpcServer` and `RpcClient` use them. */
const codecOf = (rpc: Rpc.Any, schema: "payloadSchema" | "successSchema") =>
  codecFor((rpc as unknown as Rpc.AnyWithProps)[schema]) as unknown as Schema.Codec<unknown, unknown>;

const isJsonRpcError = Schema.is(JsonRpcError);

const Id = Schema.declare(isJsonRpcId);

/** A JSON-RPC 2.0 message's fields, each checked when present. Which are present says what it is. */
const Envelope = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Id),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)])),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(JsonRpcError),
});

const isEnvelope = Schema.is(Envelope);

const isCancelParams = Schema.is(Schema.Struct({ requestId: Id }));

/**
 * Reads one JSON value as a JSON-RPC message. A message with a `method` is a request (it has an `id`)
 * or a notification; one with exactly one of `result` and `error` is a response.
 */
const classify = (value: unknown): Classified => {
  if (isResponseShaped(value) && (!isEnvelope(value) || ("result" in value) === ("error" in value))) {
    const id = value["id"];
    return { _tag: "MalformedResponse", id: isJsonRpcId(id) ? id : null };
  }
  if (!isEnvelope(value)) {
    const id = Predicate.isObject(value) ? value["id"] : null;
    return { _tag: "Invalid", id: isJsonRpcId(id) ? id : null };
  }
  const id = value.id ?? null;
  if (value.method !== undefined)
    return "id" in value
      ? { _tag: "Request", id, method: value.method, params: value.params }
      : { _tag: "Notification", method: value.method, params: value.params };
  if (value.error !== undefined) return { _tag: "Failure", id, error: value.error };
  return "result" in value ? { _tag: "Success", id, result: value.result } : { _tag: "Invalid", id };
};

/** The JSON-RPC error for a handler's encoded failure. */
const errorOf = (cause: EncodedCause): JsonRpcError => {
  const failed = cause.find((reason) => reason._tag === "Fail");
  if (failed !== undefined && isJsonRpcError(failed.error)) return failed.error;
  if (cause.some((reason) => reason._tag === "Interrupt"))
    return { code: ErrorCode.RequestCancelled, message: "Request cancelled" };
  return { code: ErrorCode.InternalError, message: "Internal error" };
};

const success = (id: JsonRpcId | null, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

const failure = (id: JsonRpcId | null, error: JsonRpcError): JsonRpcResponse => ({ jsonrpc: "2.0", id, error });

const invalidRequest: JsonRpcError = { code: ErrorCode.InvalidRequest, message: "Invalid request" };

const clientError = (message: string, cause: unknown) =>
  new RpcClientError.RpcClientError({ reason: new RpcClientError.RpcClientDefect({ message, cause }) });

export interface Options<Serve extends Rpc.Any, Call extends Rpc.Any, Notify extends Rpc.Any, RH> {
  readonly wire: Wire;
  /** The requests and notifications this end handles. */
  readonly serve: RpcGroup.RpcGroup<Serve>;
  /** The requests this end makes. */
  readonly call: RpcGroup.RpcGroup<Call>;
  /** The notifications this end sends. */
  readonly notify: RpcGroup.RpcGroup<Notify>;
  readonly handlers: (peer: Peer<Call, Notify>) => Layer.Layer<Rpc.ToHandler<Serve>, never, RH>;
}

/**
 * Runs a peer on `wire` until the wire's `read` ends or the scope closes. It serves `serve` with the
 * handlers `handlers` builds (given the peer, so a handler can call the other end), calls `call`, and
 * sends `notify`. `Rpc.ServicesServer<Serve>`, the services `serve`'s schemas need, is `never` for
 * schemas that need none, as ACP's do.
 */
export const make: <Serve extends Rpc.Any, Call extends Rpc.Any, Notify extends Rpc.Any, RH>(
  options: Options<Serve, Call, Notify, RH>,
) => Effect.Effect<Peer<Call, Notify>, never, Scope.Scope | RH | Rpc.ServicesServer<Serve>> = Effect.fnUntraced(function* <
  Serve extends Rpc.Any,
  Call extends Rpc.Any,
  Notify extends Rpc.Any,
  RH,
>(options: Options<Serve, Call, Notify, RH>) {
  const scope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const ended = yield* Deferred.make<void>();
  let open = true;

  /** Writes a message nothing waits on, after every message written before it; once the connection has closed it is dropped. */
  const post = (message: JsonRpcMessage | ReadonlyArray<JsonRpcMessage>): Effect.Effect<void> =>
    Effect.suspend(() =>
      open
        ? lock
            .withPermit(options.wire.write(message))
            .pipe(Effect.catch((error) => Effect.logWarning("acp peer: a message could not be written", error.reason)))
        : Effect.void,
    );

  const flush = (batch: Batch): Effect.Effect<void> =>
    batch.sealed && batch.expected > 0 && batch.responses.length === batch.expected
      ? post(batch.responses)
      : Effect.void;

  /** Answers an incoming request, alone or as part of its batch. */
  const respond = (batch: Batch | undefined, response: JsonRpcResponse): Effect.Effect<void> => {
    if (batch === undefined) return post(response);
    batch.responses.push(response);
    return flush(batch);
  };

  // The server half. Requests reach it under private ids; `incoming` says where each one's answer
  // goes, and `running` finds the private id of a request the other end cancels.
  const incoming = new Map<string | number, Incoming>();
  const running = new Map<JsonRpcId | null, number>();
  let nextId = 0;
  let toServer!: (clientId: number, message: RpcMessage.FromClientEncoded) => Effect.Effect<void>;
  const disconnects = yield* Queue.make<number>();
  const serverProtocol = yield* RpcServer.Protocol.make((writeRequest) => {
    toServer = writeRequest;
    return Effect.succeed({
      disconnects,
      send: (_clientId: number, response: RpcMessage.FromServerEncoded) => {
        switch (response._tag) {
          case "Exit": {
            const target = incoming.get(response.requestId);
            // A notification's response, which nothing waits for.
            if (target === undefined) return Effect.void;
            incoming.delete(response.requestId);
            if (running.get(target.id) === response.requestId) running.delete(target.id);
            const exit = response.exit;
            return respond(
              target.batch,
              exit._tag === "Success" ? success(target.id, exit.value ?? null) : failure(target.id, errorOf(exit.cause)),
            );
          }
          case "Defect":
            return post(failure(null, { code: ErrorCode.InternalError, message: "Internal error" }));
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
  // `calling` holds the method of each request still waiting for its response, by id.
  const calling = new Map<string | number, string>();
  // The methods whose success refuses `null` and accepts `{}`. The ACP SDK answers `null` when a
  // handler returns nothing, and reads `null` as `{}` itself; a `null` for one of these becomes `{}`.
  const nullAsEmpty = new Set(
    [...options.call.requests.values()]
      .filter((rpc) => {
        const decode = Schema.decodeUnknownExit(codecOf(rpc, "successSchema"));
        return Exit.isFailure(decode(null)) && Exit.isSuccess(decode({}));
      })
      .map((rpc) => rpc._tag),
  );
  let toClient!: (message: RpcMessage.FromServerEncoded) => Effect.Effect<void>;
  const clientProtocol = yield* RpcClient.Protocol.make((writeResponse, clientIds) => {
    toClient = (message) => Effect.forEach([...clientIds], (id) => writeResponse(id, message), { discard: true });
    return Effect.succeed({
      send: (_clientId: number, request: RpcMessage.FromClientEncoded) => {
        switch (request._tag) {
          case "Request":
            calling.set(request.id, request.tag);
            return Effect.suspend(() =>
              open
                ? lock
                    .withPermit(
                      options.wire.write({ jsonrpc: "2.0", id: request.id, method: request.tag, params: request.payload }),
                    )
                    .pipe(
                      Effect.mapError((error) => clientError(`The request could not be written: ${error.reason}`, error)),
                    )
                : Effect.fail(clientError("The connection closed", undefined)),
            );
          case "Interrupt":
            calling.delete(request.requestId);
            return post({ jsonrpc: "2.0", method: cancelMethod, params: { requestId: request.requestId } });
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
  const notify: Peer<Call, Notify>["notify"] = (tag, payload) => {
    const rpc = options.notify.requests.get(tag);
    if (rpc === undefined) return Effect.die(new Error(`${tag} is not in the peer's notify group`));
    return Schema.encodeUnknownEffect(codecOf(rpc, "payloadSchema"))(payload).pipe(
      Effect.orDie,
      Effect.flatMap((params) => post({ jsonrpc: "2.0", method: tag, params })),
    );
  };
  const peer: Peer<Call, Notify> = { client, notify, closed: Deferred.await(ended) };

  const serverFiber = yield* RpcServer.make(options.serve, { disableTracing: true, disableFatalDefects: true }).pipe(
    Effect.provideService(RpcServer.Protocol, serverProtocol),
    Effect.provide(options.handlers(peer)),
    Effect.forkIn(scope),
  );

  /** Runs `$/cancel_request`: interrupts the handler of the request it names, if one is running. */
  const cancel = (params: unknown): Effect.Effect<void> => {
    if (!isCancelParams(params)) return Effect.void;
    const id = running.get(params.requestId);
    if (id === undefined) return Effect.void;
    return toServer(0, { _tag: "Interrupt", requestId: id });
  };

  /** Hands one incoming JSON value to the half it is for, or answers it when it cannot be served. */
  const receive = (value: unknown, batch: Batch | undefined): Effect.Effect<void> => {
    const message = classify(value);
    const expect = () => {
      if (batch !== undefined) batch.expected++;
    };
    switch (message._tag) {
      case "Invalid":
        expect();
        return respond(batch, failure(message.id, invalidRequest));
      case "MalformedResponse": {
        // Answered under null: its id is one of this end's own requests, which the other end would
        // read as the id of a request of its own. The call it answers, if one is pending, fails.
        expect();
        const answered = respond(batch, failure(null, invalidRequest));
        if (message.id === null || !calling.has(message.id)) return answered;
        calling.delete(message.id);
        const error: JsonRpcError = {
          code: ErrorCode.InvalidRequest,
          message: "The response to this request is malformed",
          data: { response: value },
        };
        return answered.pipe(
          Effect.andThen(
            toClient({ _tag: "Exit", requestId: message.id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error }] } }),
          ),
        );
      }
      case "Success":
      case "Failure": {
        // A response to no request of this end's, or to one already answered, is dropped by the client half.
        if (message.id === null) return Effect.void;
        const method = calling.get(message.id);
        calling.delete(message.id);
        if (message._tag === "Failure")
          return toClient({
            _tag: "Exit",
            requestId: message.id,
            exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: message.error }] },
          });
        const value = message.result === null && method !== undefined && nullAsEmpty.has(method) ? {} : message.result;
        return toClient({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value } });
      }
      case "Notification":
      case "Request": {
        const isRequest = message._tag === "Request";
        if (message.method === cancelMethod) {
          if (!isRequest) return cancel(message.params);
          expect();
          return cancel(message.params).pipe(Effect.flatMap(() => respond(batch, success(message.id, null))));
        }
        const rpc = options.serve.requests.get(message.method);
        if (rpc === undefined) {
          if (!isRequest) return Effect.void;
          expect();
          return respond(
            batch,
            failure(message.id, { code: ErrorCode.MethodNotFound, message: `Method not found: ${message.method}` }),
          );
        }
        if (isRequest) expect();
        return Schema.decodeUnknownEffect(codecOf(rpc, "payloadSchema"))(message.params).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              isRequest
                ? respond(
                    batch,
                    failure(message.id, { code: ErrorCode.InvalidParams, message: "Invalid params", data: error.message }),
                  )
                : Effect.void,
            onSuccess: () => {
              const id = nextId++;
              if (isRequest) {
                incoming.set(id, { id: message.id, batch });
                running.set(message.id, id);
              }
              return toServer(0, { _tag: "Request", id, tag: message.method, payload: message.params, headers: [] });
            },
          }),
        );
      }
    }
  };

  const receiveInput = (input: WireInput): Effect.Effect<void> => {
    if (input._tag === "Unparsable") return post(failure(null, { code: ErrorCode.ParseError, message: "Parse error" }));
    if (!Array.isArray(input.value)) return receive(input.value, undefined);
    if (input.value.length === 0) return post(failure(null, invalidRequest));
    const batch: Batch = { expected: 0, sealed: false, responses: [] };
    return Effect.forEach(input.value, (value) => receive(value, batch), { discard: true }).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          batch.sealed = true;
          return flush(batch);
        }),
      ),
    );
  };

  /** Ends the connection: pending calls fail, running handlers are interrupted, `closed` completes. */
  const close = Effect.suspend(() => {
    if (!open) return Effect.void;
    open = false;
    calling.clear();
    return toClient({ _tag: "ClientProtocolError", error: clientError("The connection closed", undefined) }).pipe(
      Effect.andThen(Fiber.interrupt(serverFiber)),
      Effect.andThen(Deferred.succeed(ended, undefined)),
    );
  });

  yield* options.wire.read.pipe(
    Stream.runForEach(receiveInput),
    Effect.catch((error) => Effect.logWarning("acp peer: the connection could not be read", error.reason)),
    Effect.ensuring(close),
    Effect.forkIn(scope),
  );

  return peer;
});
