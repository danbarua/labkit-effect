/**
 * An ACP client: one implementation per protocol version it speaks, and `connect` on a wire.
 *
 * `connect` sends `initialize` offering one version it implements (the highest, unless `offer`
 * names another), in that version's field names, reads the answer's `protocolVersion` the same way
 * in every version, and continues with the implementation for the answered version. The profile's
 * client side is what the agent received: the params sent, read with the answered version's schema.
 * From then on that implementation's handlers serve the agent's requests, behind the capability
 * gates of `protocol.ts`.
 */

import { Data, Deferred, Effect, Exit, Schema, Scope } from "effect";
import type { Rpc } from "effect/rpc";
import {
  type AnyHandler,
  checkExtensions,
  type ErasedExtensions,
  type ExtensionClient,
  type ExtensionHandlers,
  type Extensions,
  type GatedClient,
  type GatedNotify,
  type Handlers,
  type Served,
  split,
  start,
} from "./endpoint.ts";
import {
  ErrorCode,
  isJsonRpcId,
  isRequest,
  isResponse,
  isResponseShaped,
  type JsonRpcError,
  type Wire,
  type WireInput,
} from "./json-rpc.ts";
import { logKeys } from "./log-keys.ts";
import { type AnyAdapter, type Profile, type ProtocolAdapter, readProtocolVersion, type Version } from "./protocol.ts";
import type { Implementation } from "./schema/v1.gen.ts";

/** A connection to an agent, in the version the agent answered. */
export interface ClientConnection<V extends Version, Call extends Rpc.Any = never, Notify extends Rpc.Any = never> {
  readonly protocolVersion: V["protocolVersion"];
  readonly profile: Profile<V>;
  /** The agent's requests. One the agent's capabilities do not allow fails with `CapabilityNotAdvertised`, and is not sent. */
  readonly agent: GatedClient<Exclude<V["agentRequests"], { readonly _tag: "initialize" }>>;
  /** The agent's notifications, gated the same way. */
  readonly notify: GatedNotify<V["agentNotifications"]>;
  /** The agent's extension methods this implementation declared it calls and sends. */
  readonly extensions: ExtensionClient<Call, Notify>;
  /** Completes when the connection ends. */
  readonly closed: Effect.Effect<void>;
}

/** Handlers for any of a version's client requests and notifications, and for the extension methods in `Serve`. */
export type ClientHandlers<V extends Version, R, Serve extends Rpc.Any = never> = Handlers<
  Served<V["clientRequests"], V["clientNotifications"]>,
  R
> &
  ExtensionHandlers<Serve, R>;

/** One protocol version, as this client speaks it. */
export interface ClientImplementation<
  V extends Version,
  R,
  Serve extends Rpc.Any = never,
  Call extends Rpc.Any = never,
  Notify extends Rpc.Any = never,
> {
  readonly adapter: ProtocolAdapter<V>;
  readonly capabilities: V["clientCapabilities"];
  readonly extensions: ErasedExtensions;
  readonly handlers: (
    connection: Omit<ClientConnection<V, Call, Notify>, "closed">,
  ) => Effect.Effect<ClientHandlers<V, R, Serve>, never, R>;
}

// oxlint-disable-next-line typescript/no-explicit-any -- any version's implementation, as a list of them holds it; `Serve` is never, as `any` would erase every handler's type
export type AnyClientImplementation = ClientImplementation<any, any, never, any, any>;

/** The services an implementation's handlers need. */
export type Requirements<I> = I extends ClientImplementation<infer _V, infer R, infer _S, infer _C, infer _N> ? R : never;

/** The connection an implementation makes, when the agent answers its version. */
export type ConnectionOf<I> =
  I extends ClientImplementation<infer V, infer _R, infer _S, infer C, infer N> ? ClientConnection<V, C, N> : never;

/** What a client's implementation of one version advertises, and its handlers. */
export interface ClientOptions<
  V extends Version,
  R,
  Serve extends Rpc.Any = never,
  Call extends Rpc.Any = never,
  Notify extends Rpc.Any = never,
> {
  readonly capabilities: V["clientCapabilities"];
  readonly handlers: (
    connection: Omit<ClientConnection<V, Call, Notify>, "closed">,
  ) => Effect.Effect<ClientHandlers<V, R, Serve>, never, R>;
}

/**
 * The client's implementation of `adapter`'s version: the capabilities it advertises, and its
 * handlers, built once per connection. A method with no handler is answered -32601.
 */
export function implement<V extends Version, R = never>(
  adapter: ProtocolAdapter<V>,
  options: ClientOptions<V, R>,
): ClientImplementation<V, R>;
/**
 * The same, with the extension methods the client serves, calls and sends. They come before the
 * options so that the handlers are typed from them; a group built inside this argument
 * (`group.omit(…)`) leaves a handlers function with no parameter untyped, so build it beforehand.
 * An extension method whose name does not start with `_` is a defect: `implement` throws.
 */
export function implement<
  V extends Version,
  R = never,
  Serve extends Rpc.Any = never,
  Call extends Rpc.Any = never,
  Notify extends Rpc.Any = never,
>(
  adapter: ProtocolAdapter<V>,
  extensions: Extensions<Serve, Call, Notify>,
  options: ClientOptions<V, R, Serve, Call, Notify>,
): ClientImplementation<V, R, Serve, Call, Notify>;
export function implement(
  adapter: AnyAdapter,
  // oxlint-disable-next-line typescript/no-explicit-any -- erased here; the overloads above type it
  ...rest: [options: ClientOptions<any, any>] | [extensions: Extensions<any, any, any>, options: ClientOptions<any, any, any, any, any>]
): AnyClientImplementation {
  const [extensions, options] = rest.length === 1 ? [undefined, rest[0]] : rest;
  return { adapter, capabilities: options.capabilities, extensions: checkExtensions(extensions), handlers: options.handlers };
}

/** The agent answered a version this client does not implement. The client stops reading the wire. */
export class UnsupportedProtocolVersion extends Data.TaggedError("UnsupportedProtocolVersion")<{
  readonly offered: number;
  readonly answered: number;
}> {}

/** `initialize` got no usable answer: the wire failed or closed, the agent answered an error or a malformed response, or a result the answered version's schema refuses. */
export class InitializeFailed extends Data.TaggedError("InitializeFailed")<{
  readonly reason: string;
  readonly error?: JsonRpcError | undefined;
  readonly cause?: unknown;
}> {}

export interface ConnectOptions<Impls extends ReadonlyArray<AnyClientImplementation>> {
  readonly wire: Wire;
  /** The client's name and version, sent in `initialize`. */
  readonly info: Implementation;
  /** One per protocol version the client speaks. */
  readonly implementations: Impls;
  /**
   * The version `initialize` offers, in that version's field names; the highest implemented when
   * left out. An agent that answers a lower version reads the params with its own schema: a client
   * that knows its agent speaks only version 1 offers 1, or the agent receives no capabilities.
   */
  readonly offer?: Impls[number]["adapter"]["protocolVersion"] | undefined;
}

type Implementations = readonly [AnyClientImplementation, ...Array<AnyClientImplementation>];

/** The id of the `initialize` request, sent before any other request. */
const initializeId = 0;

/**
 * Initializes a connection on `wire` and runs it until the wire's `read` ends or the scope closes.
 * Before `initialize` is answered, a request from the agent is answered -32600 with
 * `data: { reason: "not_initialized" }`, and anything else is dropped. An `offer` this client does
 * not implement is a defect.
 */
export const connect = <const Impls extends Implementations>(
  options: ConnectOptions<Impls>,
): Effect.Effect<
  ConnectionOf<Impls[number]>,
  UnsupportedProtocolVersion | InitializeFailed,
  Scope.Scope | Requirements<Impls[number]>
> =>
  Effect.gen(function* () {
    type R = Requirements<Impls[number]>;
    // Erased to no extension methods: `start` serves and calls them by name.
    const implementations = options.implementations as unknown as ReadonlyArray<ClientImplementation<Version, R>>;
    const byVersion = new Map(
      implementations.map((implementation) => [implementation.adapter.protocolVersion as number, implementation]),
    );
    const offered: number = options.offer ?? Math.max(...byVersion.keys());
    const offering = byVersion.get(offered);
    if (offering === undefined)
      return yield* Effect.die(new Error(`acp client: offer ${offered} is not a version in [${[...byVersion.keys()].join(", ")}]`));
    const scope = yield* Scope.fork(yield* Scope.Scope);
    const answered = yield* Deferred.make<{ readonly [key: string]: unknown }, InitializeFailed>();

    const before = (input: WireInput): Effect.Effect<boolean> => {
      if (input._tag !== "Json") return Effect.succeed(false);
      const value = input.value;
      if (isResponse(value) && value.id === initializeId) return Deferred.succeed(answered, value).pipe(Effect.as(true));
      if (isResponseShaped(value) && value["id"] === initializeId)
        return Deferred.fail(
          answered,
          new InitializeFailed({ reason: `the agent's answer to initialize is malformed: ${JSON.stringify(value)}`, cause: value }),
        ).pipe(Effect.as(true));
      if (!isRequest(value)) return Effect.succeed(false);
      return options.wire
        .write({
          jsonrpc: "2.0",
          id: isJsonRpcId(value.id) ? value.id : null,
          error: { code: ErrorCode.InvalidRequest, message: "The connection is not initialized", data: { reason: "not_initialized" } },
        })
        .pipe(
          Effect.catch((error) => Effect.logWarning("acp client: a message could not be written", error.reason)),
          Effect.as(false),
        );
    };

    const negotiate = Effect.gen(function* () {
      const { rest, ended } = yield* split(options.wire, before).pipe(Scope.provide(scope));
      const params = yield* Schema.encodeEffect(offering.adapter.initializeCodec.request)(
        offering.adapter.initializeRequest({ capabilities: offering.capabilities, info: options.info }),
      ).pipe(Effect.orDie);
      yield* options.wire
        .write({ jsonrpc: "2.0", id: initializeId, method: "initialize", params })
        .pipe(Effect.mapError((error) => new InitializeFailed({ reason: `initialize could not be sent: ${error.reason}`, cause: error })));
      yield* Effect.raceFirst(Deferred.await(answered).pipe(Effect.asVoid), ended);
      if (!(yield* Deferred.isDone(answered)))
        return yield* new InitializeFailed({ reason: "the connection closed before initialize was answered" });
      const response = yield* Deferred.await(answered);
      if ("error" in response)
        return yield* new InitializeFailed({ reason: "the agent answered initialize with an error", error: response["error"] as JsonRpcError });
      const version = readProtocolVersion(response["result"]);
      if (version === undefined)
        return yield* new InitializeFailed({ reason: "the agent's answer to initialize has no protocolVersion" });
      const implementation = byVersion.get(version);
      if (implementation === undefined) return yield* new UnsupportedProtocolVersion({ offered, answered: version });
      const adapter = implementation.adapter;
      const result = yield* Schema.decodeUnknownEffect(adapter.initializeCodec.response)(response["result"]).pipe(
        Effect.mapError(
          (error) =>
            new InitializeFailed({ reason: `the agent's answer to initialize is not version ${version}'s: ${error.message}`, cause: error }),
        ),
      );
      // What the agent received: the params sent, read as the answered version reads them. Offered a
      // higher version's field names, a version 1 agent reads no client capabilities and no info.
      const received = yield* Schema.decodeUnknownEffect(adapter.initializeCodec.request)(params).pipe(
        Effect.mapError(
          (error) =>
            new InitializeFailed({
              reason: `the initialize sent, offering version ${offered}, is not version ${version}'s: ${error.message}`,
              cause: error,
            }),
        ),
      );
      const profile = adapter.profile(received, result);
      yield* Effect.logInfo(logKeys.initialize.negotiated, { side: "client", offered, chosen: version });
      const endpoint = yield* start({
        wire: rest,
        side: "client",
        adapter,
        profile,
        extensions: implementation.extensions,
        // The endpoint's methods are erased; they are the answered version's and the implementation's extensions.
        handlers: (endpoint) =>
          implementation.handlers({
            protocolVersion: adapter.protocolVersion,
            profile,
            agent: endpoint.call as never,
            notify: endpoint.notify,
            extensions: endpoint.extensions,
          }) as Effect.Effect<Readonly<Record<string, AnyHandler<R> | undefined>>, never, R>,
      }).pipe(Scope.provide(scope));
      return {
        protocolVersion: version,
        profile,
        agent: endpoint.call,
        notify: endpoint.notify,
        extensions: endpoint.extensions,
        closed: endpoint.closed,
      } as ConnectionOf<Impls[number]>;
    });

    return yield* negotiate.pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
  });
