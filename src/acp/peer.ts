/**
 * One JSON-RPC 2.0 connection on which this end both serves requests and makes them. ACP needs
 * this: an agent serves `session/prompt` and, during it, asks the client for permission.
 *
 * `methods.ts` declares the methods: each one's name, the schema of its params and, for a request,
 * the schema of its result. The connection is built here from Effect's primitives:
 *
 * - each incoming request runs in its own fiber, in a `FiberMap` keyed by the request's id, and an
 *   incoming `$/cancel_request` interrupts that fiber, whose request is then answered -32800;
 * - each outgoing request waits on a `Deferred`, kept by id until its response arrives; a call that
 *   is interrupted while it waits sends `$/cancel_request`, and its late response is dropped;
 * - a `Semaphore` writes one message at a time, in the order they are sent;
 * - the peer's `Scope` owns every fiber; when the wire's `read` ends, pending calls fail with
 *   `PeerClosed` and running handlers are interrupted.
 *
 * Every message is read and written here, as JSON-RPC 2.0:
 *
 * - a handler's failure goes out as the `JsonRpcError` it failed with, an interruption as -32800, a
 *   defect as -32603, always answering the request that died;
 * - an unknown method is -32601 and params its schema refuses are -32602, answered before any
 *   handler runs; an unknown notification, or one whose params are refused, is dropped;
 * - a notification is run by its handler and nothing is sent back;
 * - a `null` result for a request whose result schema refuses `null` and accepts `{}` reaches the
 *   caller as `{}`, as the ACP SDK reads it: the SDK answers `null` when a handler returns nothing;
 * - a result is decoded with its method's result schema, so the schema's default-on-error and
 *   skip-invalid-items fallbacks apply to it, and a result the schema refuses fails its call with
 *   -32603;
 * - a malformed response is answered -32600 under id null, and the pending call whose id it
 *   carries fails with the `JsonRpcError` -32600 "The response to this request is malformed";
 * - a batch's responses are written as one array once every request in it is answered.
 */

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  FiberSet,
  Predicate,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
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
import type * as Methods from "./methods.ts";
import { PeerClosed } from "./methods.ts";

/** The method of the notification that cancels a request, in either direction. */
export const cancelMethod = "$/cancel_request";

export interface Peer<Call extends Methods.Any, Notify extends Methods.Any> {
  /**
   * Requests to the other end, typed by the `call` set. A call fails with the `JsonRpcError` the
   * other end answers, and with `PeerClosed` when the connection closes before it is answered or
   * the request cannot be written.
   */
  readonly client: Methods.Caller<Call>;
  /** Sends a notification of the `notify` set. Nothing is sent once the connection has closed. */
  readonly notify: Methods.Notify<Notify>;
  /** Completes when the wire's `read` ends or fails, or the peer's scope closes. */
  readonly closed: Effect.Effect<void>;
}

export interface Options<Serve extends Methods.Any, Call extends Methods.Any, Notify extends Methods.Any, R> {
  readonly wire: Wire;
  /** The requests and notifications this end handles. */
  readonly serve: Methods.MethodSet<Serve>;
  /** The requests this end makes. */
  readonly call: Methods.MethodSet<Call>;
  /** The notifications this end sends. */
  readonly notify: Methods.MethodSet<Notify>;
  /** Builds the handlers once, given the peer, so that a handler can call the other end. */
  readonly handlers: (peer: Peer<Call, Notify>) => Effect.Effect<Methods.Handlers<Serve, R>, never, R>;
  /**
   * The id of this end's first request; each later one counts up from it. 0 when left out. An end
   * that sent requests of its own before the peer started begins after their ids.
   */
  readonly firstId?: number | undefined;
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

/** Where the answer to an incoming request goes: written alone, or kept for its batch. */
type Answer = (response: JsonRpcResponse) => Effect.Effect<void>;

/**
 * What an incoming message is owed: nothing, an answer now, or an answer once the handler `start`
 * runs has finished; `R` is what the handler needs.
 */
type Reply<R> =
  | { readonly _tag: "None" }
  | { readonly _tag: "Now"; readonly response: JsonRpcResponse }
  | { readonly _tag: "Later"; readonly start: (answer: Answer) => Effect.Effect<void, never, R> };

/** A call waiting for its response. */
interface Pending {
  readonly method: Methods.Request;
  readonly answer: Deferred.Deferred<unknown, JsonRpcError | PeerClosed>;
}

/** Handlers with their methods erased. */
type ErasedHandlers<R> = Readonly<Record<string, ((payload: unknown) => Effect.Effect<unknown, JsonRpcError, R>) | undefined>>;

/** The JSON codec of one of a method's schemas. */
const json = (schema: Schema.Top) => Schema.toCodecJson(schema) as unknown as Schema.Codec<unknown, unknown>;

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

const success = (id: JsonRpcId | null, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

const failure = (id: JsonRpcId | null, error: JsonRpcError): JsonRpcResponse => ({ jsonrpc: "2.0", id, error });

const invalidRequest: JsonRpcError = { code: ErrorCode.InvalidRequest, message: "Invalid request" };

const internalError: JsonRpcError = { code: ErrorCode.InternalError, message: "Internal error" };

const none: Reply<never> = { _tag: "None" };

const now = (response: JsonRpcResponse): Reply<never> => ({ _tag: "Now", response });

/** The JSON-RPC error a handler's failure goes out as: its typed error, else -32800 for an interruption, else -32603. */
const errorOf = (cause: Cause.Cause<unknown>): JsonRpcError => {
  const failed = Cause.findError(cause);
  if (Result.isSuccess(failed) && isJsonRpcError(failed.success)) return failed.success;
  if (Cause.hasInterrupts(cause)) return { code: ErrorCode.RequestCancelled, message: "Request cancelled" };
  return internalError;
};

/**
 * The response to request `id` once its handler has exited. A result its schema cannot encode is
 * -32603; a notification's handler, run for a request, answers `null`.
 */
const responseOf = (id: JsonRpcId | null, method: Methods.Any, exit: Exit.Exit<unknown, JsonRpcError>): JsonRpcResponse => {
  if (Exit.isFailure(exit)) return failure(id, errorOf(exit.cause));
  if (method._tag === "Notification") return success(id, null);
  const encoded = Schema.encodeUnknownExit(json(method.result))(exit.value);
  return Exit.isSuccess(encoded) ? success(id, encoded.value ?? null) : failure(id, internalError);
};

/**
 * A call's result as its method's result schema decodes it. A `null` the schema refuses becomes
 * `{}` when the schema accepts `{}`. A result the schema refuses is the `JsonRpcError` -32603
 * naming the method.
 */
const resultOf = (method: Methods.Request, result: unknown): Exit.Exit<unknown, JsonRpcError> => {
  const decode = Schema.decodeUnknownExit(json(method.result));
  const decoded = decode(result);
  if (Exit.isSuccess(decoded)) return Exit.succeed(decoded.value);
  if (result === null) {
    const empty = decode({});
    if (Exit.isSuccess(empty)) return Exit.succeed(empty.value);
  }
  return Exit.fail({
    code: ErrorCode.InternalError,
    message: `The result does not match ${method.name}'s schema`,
    data: { result, issue: String(Cause.squash(decoded.cause)) },
  });
};

/**
 * Runs a peer on `wire` until the wire's `read` ends or the scope closes. It serves `serve` with the
 * handlers `handlers` builds (given the peer, so a handler can call the other end), calls `call`, and
 * sends `notify`.
 */
export const make: <Serve extends Methods.Any, Call extends Methods.Any, Notify extends Methods.Any, R>(
  options: Options<Serve, Call, Notify, R>,
) => Effect.Effect<Peer<Call, Notify>, never, Scope.Scope | R> = Effect.fnUntraced(function* <
  Serve extends Methods.Any,
  Call extends Methods.Any,
  Notify extends Methods.Any,
  R,
>(options: Options<Serve, Call, Notify, R>) {
  const scope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const ended = yield* Deferred.make<void>();
  // Each incoming request's handler, by the request's id.
  const running = yield* FiberMap.make<JsonRpcId | null>();
  // Notification handlers, requests whose id is already running, cancellations and batches waiting for their answers.
  const background = yield* FiberSet.make();
  // Each outgoing request still waiting for its response, by id.
  const pending = new Map<JsonRpcId, Pending>();
  let nextId = options.firstId ?? 0;
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

  /** Takes the pending call `id` answers, if one waits. */
  const take = (id: JsonRpcId | null): Pending | undefined => {
    if (id === null) return undefined;
    const call = pending.get(id);
    pending.delete(id);
    return call;
  };

  /** One method of `call`, as the client calls it. */
  const callOf =
    (method: Methods.Request) =>
    (payload: unknown): Effect.Effect<unknown, JsonRpcError | PeerClosed> =>
      Effect.suspend(() => Schema.encodeUnknownEffect(json(method.params))(method.params.make(payload))).pipe(
        Effect.orDie,
        Effect.flatMap((params) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.suspend(() => {
              if (!open) return Effect.fail(new PeerClosed({ reason: "The connection closed" }));
              const id = nextId++;
              const answer = Deferred.makeUnsafe<unknown, JsonRpcError | PeerClosed>();
              pending.set(id, { method, answer });
              return restore(
                lock.withPermit(options.wire.write({ jsonrpc: "2.0", id, method: method.name, params })).pipe(
                  Effect.mapError((error) => new PeerClosed({ reason: `The request could not be written: ${error.reason}` })),
                  Effect.andThen(Deferred.await(answer)),
                ),
              ).pipe(
                Effect.onExit((exit) =>
                  // Still pending when interrupted: the other end is told to stop, and its answer will be dropped.
                  pending.delete(id) && Exit.hasInterrupts(exit)
                    ? post({ jsonrpc: "2.0", method: cancelMethod, params: { requestId: id } })
                    : Effect.void,
                ),
              );
            }),
          ),
        ),
      );

  const client = Object.fromEntries(
    [...options.call.byName.values()].flatMap((method) => (method._tag === "Request" ? [[method.name, callOf(method)]] : [])),
  ) as Methods.Caller<Call>;

  const notify: Peer<Call, Notify>["notify"] = (name, payload) => {
    const method = options.notify.byName.get(name);
    if (method === undefined) return Effect.die(new Error(`${name} is not in the peer's notify set`));
    return Schema.encodeUnknownEffect(json(method.params))(payload).pipe(
      Effect.orDie,
      Effect.flatMap((params) => post({ jsonrpc: "2.0", method: name, params })),
    );
  };

  const peer: Peer<Call, Notify> = { client, notify, closed: Deferred.await(ended) };

  // Built in the background, as a handler may call the other end, whose answer the reader must read.
  const handlers = yield* options.handlers(peer).pipe(Effect.forkIn(scope));

  /** Runs `method`'s handler on `payload`; its exit goes to `answer`, if one is given. */
  const handle = (method: Methods.Any, payload: unknown, answer?: (exit: Exit.Exit<unknown, JsonRpcError>) => Effect.Effect<void>) =>
    Fiber.join(handlers).pipe(
      Effect.flatMap((built) => {
        const handler = (built as ErasedHandlers<R>)[method.name];
        if (handler === undefined)
          return Effect.fail<JsonRpcError>({ code: ErrorCode.MethodNotFound, message: `Method not found: ${method.name}` });
        return handler(payload);
      }),
      Effect.onExit((exit) => answer?.(exit) ?? Effect.void),
      Effect.exit,
    );

  /** Runs `$/cancel_request`: interrupts the handler of the request it names, if one is running. */
  const cancel = (params: unknown): Effect.Effect<void> =>
    isCancelParams(params) && FiberMap.hasUnsafe(running, params.requestId)
      ? FiberSet.run(background, FiberMap.remove(running, params.requestId)).pipe(Effect.asVoid)
      : Effect.void;

  /** Acts on one incoming JSON value, and says what it is owed. */
  const receive = (value: unknown): Effect.Effect<Reply<R>, never, R> => {
    const message = classify(value);
    switch (message._tag) {
      case "Invalid":
        return Effect.succeed(now(failure(message.id, invalidRequest)));
      case "MalformedResponse": {
        // Answered under null: its id is one of this end's own requests, which the other end would
        // read as the id of a request of its own. The call it answers, if one is pending, fails.
        const call = take(message.id);
        const answered = Effect.succeed(now(failure(null, invalidRequest)));
        if (call === undefined) return answered;
        const error: JsonRpcError = {
          code: ErrorCode.InvalidRequest,
          message: "The response to this request is malformed",
          data: { response: value },
        };
        return Deferred.fail(call.answer, error).pipe(Effect.andThen(answered));
      }
      case "Success":
      case "Failure": {
        // A response to no request of this end's, or to one already answered or cancelled, is dropped.
        const call = take(message.id);
        if (call === undefined) return Effect.succeed(none);
        const exit = message._tag === "Success" ? resultOf(call.method, message.result) : Exit.fail(message.error);
        return Deferred.done(call.answer, exit).pipe(Effect.as(none));
      }
      case "Notification":
      case "Request": {
        const isRequest = message._tag === "Request";
        if (message.method === cancelMethod)
          return cancel(message.params).pipe(Effect.as(isRequest ? now(success(message.id, null)) : none));
        const method: Methods.Any | undefined = options.serve.byName.get(message.method);
        if (method === undefined)
          return Effect.succeed(
            isRequest
              ? now(failure(message.id, { code: ErrorCode.MethodNotFound, message: `Method not found: ${message.method}` }))
              : none,
          );
        return Schema.decodeUnknownEffect(json(method.params))(message.params).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.succeed(
                isRequest
                  ? now(failure(message.id, { code: ErrorCode.InvalidParams, message: "Invalid params", data: error.message }))
                  : none,
              ),
            onSuccess: (payload): Effect.Effect<Reply<R>, never, R> => {
              if (!isRequest) return FiberSet.run(background, handle(method, payload)).pipe(Effect.as(none));
              const { id } = message;
              const start = (answer: Answer) => {
                const handled = handle(method, payload, (exit) => answer(responseOf(id, method, exit)));
                // A second request under an id still running is served, but cannot be cancelled by id.
                return (
                  FiberMap.hasUnsafe(running, id) ? FiberSet.run(background, handled) : FiberMap.run(running, id, handled)
                ).pipe(Effect.asVoid);
              };
              return Effect.succeed({ _tag: "Later", start });
            },
          }),
        );
      }
    }
  };

  /** Acts on one wire input and writes what it is owed; a batch's answers go out together, as one array. */
  const receiveInput = (input: WireInput): Effect.Effect<void, never, R> => {
    if (input._tag === "Unparsable") return post(failure(null, { code: ErrorCode.ParseError, message: "Parse error" }));
    if (!Array.isArray(input.value))
      return Effect.flatMap(receive(input.value), (reply) =>
        reply._tag === "Now" ? post(reply.response) : reply._tag === "Later" ? reply.start(post) : Effect.void,
      );
    if (input.value.length === 0) return post(failure(null, invalidRequest));
    return Effect.forEach(input.value, (value) =>
      Effect.flatMap(receive(value), (reply) => {
        if (reply._tag === "None") return Effect.succeed([]);
        if (reply._tag === "Now") return Effect.succeed([{ later: false, response: Effect.succeed(reply.response) }]);
        return Effect.flatMap(Deferred.make<JsonRpcResponse>(), (answered) =>
          reply.start((response) => Deferred.succeed(answered, response)).pipe(
            Effect.as([{ later: true, response: Deferred.await(answered) }]),
          ),
        );
      }),
    ).pipe(
      Effect.flatMap((replies) => {
        const owed = replies.flat();
        if (owed.length === 0) return Effect.void;
        const written = Effect.forEach(owed, (reply) => reply.response).pipe(Effect.flatMap(post));
        // Waiting for a handler here would stop the reader, which its calls to the other end need.
        return owed.some((reply) => reply.later) ? FiberSet.run(background, written).pipe(Effect.asVoid) : written;
      }),
    );
  };

  /** Ends the connection: pending calls fail, running handlers are interrupted, `closed` completes. */
  const close = Effect.suspend(() => {
    if (!open) return Effect.void;
    open = false;
    const calls = [...pending.values()];
    pending.clear();
    return Effect.forEach(calls, (call) => Deferred.fail(call.answer, new PeerClosed({ reason: "The connection closed" })), {
      discard: true,
    }).pipe(
      Effect.andThen(FiberMap.clear(running)),
      Effect.andThen(FiberSet.clear(background)),
      Effect.andThen(Fiber.interrupt(handlers)),
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
