/**
 * An ACP client: one implementation per protocol version it speaks, and `connect` on a wire.
 *
 * `connect` sends `initialize` offering the highest version it implements, in that version's field
 * names, reads the answer's `protocolVersion` the same way in every version, and continues with the
 * implementation for the answered version. From then on that implementation's handlers serve the
 * agent's requests, behind the capability gates of `protocol.ts`.
 */

import { Data, Deferred, Effect, Exit, Schema, Scope } from "effect";
import {
  type AnyHandler,
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
  type JsonRpcError,
  type Wire,
  type WireInput,
} from "./json-rpc.ts";
import { logKeys } from "./log-keys.ts";
import { type Profile, type ProtocolAdapter, readProtocolVersion, type Version } from "./protocol.ts";
import type { Implementation } from "./schema/v1.gen.ts";

/** A connection to an agent, in the version the agent answered. */
export interface ClientConnection<V extends Version> {
  readonly protocolVersion: V["protocolVersion"];
  readonly profile: Profile<V>;
  /** The agent's requests. One the agent's capabilities do not allow fails with `CapabilityNotAdvertised`, and is not sent. */
  readonly agent: GatedClient<Exclude<V["agentRequests"], { readonly _tag: "initialize" }>>;
  /** The agent's notifications, gated the same way. */
  readonly notify: GatedNotify<V["agentNotifications"]>;
  /** Completes when the connection ends. */
  readonly closed: Effect.Effect<void>;
}

/** Handlers for any of a version's client requests and notifications. */
export type ClientHandlers<V extends Version, R> = Handlers<Served<V["clientRequests"], V["clientNotifications"]>, R>;

/** One protocol version, as this client speaks it. */
export interface ClientImplementation<V extends Version, R> {
  readonly adapter: ProtocolAdapter<V>;
  readonly capabilities: V["clientCapabilities"];
  readonly handlers: (connection: Omit<ClientConnection<V>, "closed">) => Effect.Effect<ClientHandlers<V, R>, never, R>;
}

// oxlint-disable-next-line typescript/no-explicit-any -- any version's implementation, as a list of them holds it
export type AnyClientImplementation = ClientImplementation<any, any>;

/** The services an implementation's handlers need. */
export type Requirements<I> = I extends ClientImplementation<infer _V, infer R> ? R : never;

/** The connection an implementation makes, when the agent answers its version. */
export type ConnectionOf<I> = I extends ClientImplementation<infer V, infer _R> ? ClientConnection<V> : never;

/**
 * The client's implementation of `adapter`'s version: the capabilities it advertises, and its
 * handlers, built once per connection. A method with no handler is answered -32601.
 */
export const implement = <V extends Version, R = never>(
  adapter: ProtocolAdapter<V>,
  options: {
    readonly capabilities: V["clientCapabilities"];
    readonly handlers: (connection: Omit<ClientConnection<V>, "closed">) => Effect.Effect<ClientHandlers<V, R>, never, R>;
  },
): ClientImplementation<V, R> => ({ adapter, capabilities: options.capabilities, handlers: options.handlers });

/** The agent answered a version this client does not implement. The client stops reading the wire. */
export class UnsupportedProtocolVersion extends Data.TaggedError("UnsupportedProtocolVersion")<{
  readonly offered: number;
  readonly answered: number;
}> {}

/** `initialize` got no usable answer: the wire failed or closed, the agent answered an error, or a result the answered version's schema refuses. */
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
}

type Implementations = readonly [AnyClientImplementation, ...Array<AnyClientImplementation>];

/** The id of the `initialize` request, sent before any other request. */
const initializeId = 0;

/**
 * Initializes a connection on `wire` and runs it until the wire's `read` ends or the scope closes.
 * Before `initialize` is answered, a request from the agent is answered -32600 with
 * `data: { reason: "not_initialized" }`, and anything else is dropped.
 */
export const connect = <const Impls extends Implementations>(
  options: ConnectOptions<Impls>,
): Effect.Effect<
  ConnectionOf<Impls[number]>,
  UnsupportedProtocolVersion | InitializeFailed,
  Scope.Scope | Requirements<Impls[number]>
> =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Scope.Scope);
    type R = Requirements<Impls[number]>;
    const implementations: ReadonlyArray<ClientImplementation<Version, R>> = options.implementations;
    const byVersion = new Map(
      implementations.map((implementation) => [implementation.adapter.protocolVersion as number, implementation]),
    );
    const offered = Math.max(...byVersion.keys());
    const highest = byVersion.get(offered) as ClientImplementation<Version, R>;
    const answered = yield* Deferred.make<{ readonly [key: string]: unknown }>();

    const before = (input: WireInput): Effect.Effect<boolean> => {
      if (input._tag !== "Json") return Effect.succeed(false);
      const value = input.value;
      if (isResponse(value) && value.id === initializeId) return Deferred.succeed(answered, value).pipe(Effect.as(true));
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
      const params = yield* Schema.encodeEffect(highest.adapter.initializeCodec.request)(
        highest.adapter.initializeRequest({ capabilities: highest.capabilities, info: options.info }),
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
      const profile = adapter.profile(
        adapter.initializeRequest({ capabilities: implementation.capabilities, info: options.info }),
        result,
      );
      yield* Effect.logInfo(logKeys.initialize.negotiated, { side: "client", offered, chosen: version });
      const endpoint = yield* start({
        wire: rest,
        side: "client",
        adapter,
        profile,
        // The endpoint's methods are erased; they are the answered version's.
        handlers: (endpoint) =>
          implementation.handlers({
            protocolVersion: adapter.protocolVersion,
            profile,
            agent: endpoint.call as never,
            notify: endpoint.notify,
          }) as Effect.Effect<Readonly<Record<string, AnyHandler<R> | undefined>>, never, R>,
      }).pipe(Scope.provide(scope));
      return {
        protocolVersion: version,
        profile,
        agent: endpoint.call,
        notify: endpoint.notify,
        closed: endpoint.closed,
      } as ConnectionOf<Impls[number]>;
    });

    return yield* negotiate.pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
  });
