/**
 * An ACP agent, shaped like Effect's `McpServer`: one implementation per protocol version it
 * speaks, `run` on a wire, or `layerStdio` and `layerHttp` to serve one.
 *
 * The library answers `initialize` itself. It reads the offered `protocolVersion` the same way in
 * every version, chooses a version with `select`, decodes the request with that version's schema,
 * and answers in that version's field names. From then on the chosen implementation's handlers
 * serve the connection, behind the capability gates of `protocol.ts`.
 */

import { Deferred, Effect, Layer, References, Schema, type Stdio } from "effect";
import type { HttpRouter } from "effect/http";
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
import * as Http from "./http.ts";
import {
  ErrorCode,
  isJsonRpcId,
  isRequest,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcResponse,
  type Wire,
  type WireInput,
} from "./json-rpc.ts";
import { logKeys } from "./log-keys.ts";
import { type AnyAdapter, type Profile, type ProtocolAdapter, readProtocolVersion, select, type Version } from "./protocol.ts";
import type { Implementation } from "./schema/v1.gen.ts";
import { fromStdio } from "./stdio.ts";

/**
 * The connection a version's handlers are given: what was negotiated, the client's methods, and
 * the client's extension methods this implementation declared it calls and sends.
 */
export interface AgentConnection<V extends Version, Call extends Rpc.Any = never, Notify extends Rpc.Any = never> {
  readonly profile: Profile<V>;
  /** The client's requests. One the client's capabilities do not allow fails with `CapabilityNotAdvertised`, and is not sent. */
  readonly client: GatedClient<V["clientRequests"]>;
  /** The client's notifications, gated the same way. */
  readonly notify: GatedNotify<V["clientNotifications"]>;
  readonly extensions: ExtensionClient<Call, Notify>;
}

/** Handlers for any of a version's agent requests and notifications except `initialize`, and for the extension methods in `Serve`. */
export type AgentHandlers<V extends Version, R, Serve extends Rpc.Any = never> = Handlers<
  Exclude<Served<V["agentRequests"], V["agentNotifications"]>, { readonly _tag: "initialize" }>,
  R
> &
  ExtensionHandlers<Serve, R>;

/** One protocol version, as this agent speaks it. */
export interface AgentImplementation<
  V extends Version,
  R,
  Serve extends Rpc.Any = never,
  Call extends Rpc.Any = never,
  Notify extends Rpc.Any = never,
> {
  readonly adapter: ProtocolAdapter<V>;
  readonly capabilities: V["agentCapabilities"];
  readonly authMethods: ReadonlyArray<V["authMethod"]>;
  readonly extensions: ErasedExtensions;
  readonly handlers: (connection: AgentConnection<V, Call, Notify>) => Effect.Effect<AgentHandlers<V, R, Serve>, never, R>;
}

// oxlint-disable-next-line typescript/no-explicit-any -- any version's implementation, as a list of them holds it; `Serve` is never, as `any` would erase every handler's type
export type AnyAgentImplementation = AgentImplementation<any, any, never, any, any>;

/** The services an implementation's handlers need. */
export type Requirements<I> = I extends AgentImplementation<infer _V, infer R, infer _S, infer _C, infer _N> ? R : never;

/** What an agent's implementation of one version advertises, and its handlers. */
export interface AgentOptions<
  V extends Version,
  R,
  Serve extends Rpc.Any = never,
  Call extends Rpc.Any = never,
  Notify extends Rpc.Any = never,
> {
  readonly capabilities: V["agentCapabilities"];
  /** Those of type `terminal` are offered only to a client that advertises terminal auth. */
  readonly authMethods?: ReadonlyArray<V["authMethod"]> | undefined;
  readonly handlers: (connection: AgentConnection<V, Call, Notify>) => Effect.Effect<AgentHandlers<V, R, Serve>, never, R>;
}

/**
 * The agent's implementation of `adapter`'s version: the capabilities and auth methods it
 * advertises, and its handlers, built once per connection. A method with no handler is answered
 * -32601.
 */
export function implement<V extends Version, R = never>(
  adapter: ProtocolAdapter<V>,
  options: AgentOptions<V, R>,
): AgentImplementation<V, R>;
/**
 * The same, with the extension methods the agent serves, calls and sends. They come before the
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
  options: AgentOptions<V, R, Serve, Call, Notify>,
): AgentImplementation<V, R, Serve, Call, Notify>;
export function implement(
  adapter: AnyAdapter,
  // oxlint-disable-next-line typescript/no-explicit-any -- erased here; the overloads above type it
  ...rest: [options: AgentOptions<any, any>] | [extensions: Extensions<any, any, any>, options: AgentOptions<any, any, any, any, any>]
): AnyAgentImplementation {
  const [extensions, options] = rest.length === 1 ? [undefined, rest[0]] : rest;
  return {
    adapter,
    capabilities: options.capabilities,
    authMethods: options.authMethods ?? [],
    extensions: checkExtensions(extensions),
    handlers: options.handlers,
  };
}

export interface RunOptions<Impls extends ReadonlyArray<AnyAgentImplementation>> {
  readonly wire: Wire;
  /** The agent's name and version, sent in the answer to `initialize`. */
  readonly info: Implementation;
  /** One per protocol version the agent speaks. */
  readonly implementations: Impls;
}

type Implementations = readonly [AnyAgentImplementation, ...Array<AnyAgentImplementation>];

const notInitialized: JsonRpcError = {
  code: ErrorCode.InvalidRequest,
  message: "The connection is not initialized",
  data: { reason: "not_initialized" },
};

const failure = (id: JsonRpcId | null, error: JsonRpcError): JsonRpcResponse => ({ jsonrpc: "2.0", id, error });

interface Negotiated<R> {
  readonly implementation: AgentImplementation<Version, R>;
  readonly profile: Profile<Version>;
}

/**
 * Runs the agent on `wire` until the wire's `read` ends.
 *
 * Before `initialize`, a request is answered -32600 with `data: { reason: "not_initialized" }`
 * (each request in a batch, as one array), a line that is not JSON -32700, and anything else is
 * dropped. `initialize` whose params have no `protocolVersion`, or that the chosen version's schema
 * refuses, is answered -32602 and the connection stays uninitialized. Once initialized, a second
 * `initialize` is answered -32600 with `data: { reason: "already_initialized" }`.
 */
export const run = <const Impls extends Implementations>(
  options: RunOptions<Impls>,
): Effect.Effect<void, never, Requirements<Impls[number]>> =>
  Effect.scoped(
    Effect.gen(function* () {
      type R = Requirements<Impls[number]>;
      // Erased to no extension methods: `start` serves and calls them by name.
      const implementations = options.implementations as unknown as ReadonlyArray<AgentImplementation<Version, R>>;
      const byVersion = new Map(implementations.map((implementation) => [implementation.adapter.protocolVersion as number, implementation]));
      const supported = [...byVersion.keys()] as unknown as readonly [number, ...Array<number>];
      const negotiated = yield* Deferred.make<Negotiated<R>>();
      const send = (message: JsonRpcResponse | ReadonlyArray<JsonRpcResponse>) =>
        options.wire
          .write(message)
          .pipe(Effect.catch((error) => Effect.logWarning("acp agent: a message could not be written", error.reason)));

      const initialize = (id: JsonRpcId | null, params: unknown): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const offered = readProtocolVersion(params);
          if (offered === undefined) {
            yield* send(failure(id, { code: ErrorCode.InvalidParams, message: "initialize needs an integer protocolVersion" }));
            return false;
          }
          const chosen = select(supported, offered);
          const implementation = byVersion.get(chosen) as AgentImplementation<Version, R>;
          const adapter = implementation.adapter;
          const decoded = yield* Schema.decodeUnknownEffect(adapter.initializeCodec.request)(params).pipe(Effect.result);
          if (decoded._tag === "Failure") {
            yield* send(failure(id, { code: ErrorCode.InvalidParams, message: "Invalid params", data: decoded.failure.message }));
            return false;
          }
          const response = adapter.initializeResponse({
            capabilities: implementation.capabilities,
            info: options.info,
            authMethods: adapter.offeredAuthMethods(decoded.success, implementation.authMethods),
          });
          const result = yield* Schema.encodeEffect(adapter.initializeCodec.response)(response).pipe(Effect.orDie);
          yield* send({ jsonrpc: "2.0", id, result });
          yield* Effect.logInfo(logKeys.initialize.negotiated, { side: "agent", offered, chosen, supported });
          yield* Deferred.succeed(negotiated, { implementation, profile: adapter.profile(decoded.success, response) });
          return true;
        });

      const before = (input: WireInput): Effect.Effect<boolean> => {
        if (input._tag === "Unparsable")
          return send(failure(null, { code: ErrorCode.ParseError, message: "Parse error" })).pipe(Effect.as(false));
        const value = input.value;
        if (Array.isArray(value)) {
          const answers =
            value.length === 0
              ? [failure(null, { code: ErrorCode.InvalidRequest, message: "Invalid request" })]
              : value.filter(isRequest).map((request) => failure(isJsonRpcId(request.id) ? request.id : null, notInitialized));
          return (answers.length === 0 ? Effect.void : send(answers)).pipe(Effect.as(false));
        }
        if (!isRequest(value) || typeof value["method"] !== "string") return Effect.succeed(false);
        const id = isJsonRpcId(value.id) ? value.id : null;
        if (value["method"] === "initialize") return initialize(id, value["params"]);
        return send(failure(id, notInitialized)).pipe(Effect.as(false));
      };

      const { rest, ended } = yield* split(options.wire, before);
      yield* Effect.raceFirst(Deferred.await(negotiated).pipe(Effect.asVoid), ended);
      if (!(yield* Deferred.isDone(negotiated))) return;
      const { implementation, profile } = yield* Deferred.await(negotiated);
      const endpoint = yield* start({
        wire: rest,
        side: "agent",
        adapter: implementation.adapter,
        profile,
        extensions: implementation.extensions,
        // The endpoint's methods are erased; they are the chosen version's and the implementation's extensions.
        handlers: (endpoint) =>
          implementation.handlers({
            profile,
            client: endpoint.call as never,
            notify: endpoint.notify,
            extensions: endpoint.extensions,
          }) as Effect.Effect<Readonly<Record<string, AnyHandler<R> | undefined>>, never, R>,
      });
      yield* endpoint.closed;
    }),
  );

/**
 * The agent on this process's stdin and stdout, as an editor launches it, for as long as the layer
 * lives. It runs until stdin closes. Its logs, the negotiation's included, go to stderr: stdout
 * carries only protocol messages.
 */
export const layerStdio = <const Impls extends Implementations>(
  options: Omit<RunOptions<Impls>, "wire">,
): Layer.Layer<never, never, Stdio.Stdio | Requirements<Impls[number]>> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const wire = yield* fromStdio;
      return yield* run({ ...options, wire });
    }).pipe(Effect.provideService(References.LogToStderr, true), Effect.forkScoped),
  );

/**
 * The agent over ACP's Streamable HTTP transport at `path` (default `/acp`): one `run` per ACP
 * connection, as `http.serve` makes them.
 */
export const layerHttp = <const Impls extends Implementations>(
  options: Omit<RunOptions<Impls>, "wire"> & Omit<Http.ServeOptions<never>, "onConnection">,
): Layer.Layer<never, never, HttpRouter.HttpRouter | Requirements<Impls[number]>> =>
  Http.serve<Requirements<Impls[number]>>({
    path: options.path,
    keepAliveInterval: options.keepAliveInterval,
    onConnection: (wire) => run({ wire, info: options.info, implementations: options.implementations }),
  }) as Layer.Layer<never, never, HttpRouter.HttpRouter | Requirements<Impls[number]>>;
