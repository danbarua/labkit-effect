/**
 * What the agent and the client share once `initialize` is answered: the peer on the negotiated
 * version's method sets, with each side's capability gates in front of it.
 *
 * - `split` reads a wire through `before` until `before` hands it over (when `initialize` is
 *   answered); every later message is kept for the peer, so none is lost while it starts.
 * - `start` runs the peer. An incoming request a gate refuses is answered -32601 or -32602 naming
 *   the capability, and an incoming notification it refuses is dropped, both before any handler
 *   runs. An outgoing request or notification a gate refuses fails with `CapabilityNotAdvertised`
 *   and nothing is sent.
 * - An implementation's extension methods (`_`-prefixed, `Extensions`) are served beside the
 *   version's methods and called through `extensions`; no gate stands in front of them.
 */

import { type Cause, Deferred, Effect, Queue, type Scope, Stream } from "effect";
import { ErrorCode, type JsonRpcError, type Wire, type WireError, type WireInput } from "./json-rpc.ts";
import { logKeys } from "./log-keys.ts";
import * as Methods from "./methods.ts";
import * as Peer from "./peer.ts";
import {
  type AnyAdapter,
  CapabilityNotAdvertised,
  type Direction,
  isExtensionMethod,
  type Profile,
  refusalError,
  type Version,
} from "./protocol.ts";

/** Which end of the connection this is. */
export type Side = "agent" | "client";

/** A handler of a method this end serves, its payload erased; `R` is the services it needs. */
export type AnyHandler<R> = (payload: never) => Effect.Effect<unknown, JsonRpcError, R>;

/** Handlers by method name for any subset of the methods `M`. */
export type Handlers<M extends Methods.Any, R> = Partial<Methods.Handlers<M, R>>;

/** The methods one end serves: its requests, and the notifications that are not also requests (`mcp/message` is both). */
export type Served<Requests extends Methods.Any, Notifications extends Methods.Any> =
  | Requests
  | Exclude<Notifications, { readonly name: Requests["name"] }>;

/** The other end's requests, called through the gates. */
export type GatedClient<M extends Methods.Any> = Methods.Caller<M, CapabilityNotAdvertised>;

/** Sends one of the other end's notifications through the gates. */
export type GatedNotify<M extends Methods.Any> = Methods.Notify<M, CapabilityNotAdvertised>;

/**
 * The extension methods an implementation declares: those it serves (requests and notifications
 * alike, handled in the same record as the version's methods), those it calls, and the
 * notifications it sends. Every method name starts with `_`.
 */
export interface Extensions<Serve extends Methods.Any = never, Call extends Methods.Any = never, Notify extends Methods.Any = never> {
  readonly serve?: Methods.MethodSet<Serve> | undefined;
  readonly call?: Methods.MethodSet<Call> | undefined;
  readonly notify?: Methods.MethodSet<Notify> | undefined;
}

/** The other end's extension methods, as an implementation declared them; no gate stands in front of them. */
export interface ExtensionClient<Call extends Methods.Any, Notify extends Methods.Any> {
  readonly call: Methods.Caller<Call>;
  readonly notify: Methods.Notify<Notify>;
}

/** Extension sets with their methods erased, as an implementation keeps them. */
export interface ErasedExtensions {
  readonly serve: Methods.MethodSet<Methods.Any>;
  readonly call: Methods.MethodSet<Methods.Any>;
  readonly notify: Methods.MethodSet<Methods.Any>;
}

/** `extensions`, erased, once each of its method names is checked to start with `_`; a name that does not is a defect, thrown. */
export const checkExtensions = <Serve extends Methods.Any, Call extends Methods.Any, Notify extends Methods.Any>(
  extensions: Extensions<Serve, Call, Notify> | undefined,
): ErasedExtensions => {
  // A set is invariant in its methods; erased, a set of none is a set of any.
  const erase = (set: Methods.MethodSet<Serve> | Methods.MethodSet<Call> | Methods.MethodSet<Notify> | undefined) =>
    (set ?? Methods.make()) as unknown as Methods.MethodSet<Methods.Any>;
  const erased = { serve: erase(extensions?.serve), call: erase(extensions?.call), notify: erase(extensions?.notify) };
  for (const set of [erased.serve, erased.call, erased.notify])
    for (const method of set.byName.keys())
      if (!isExtensionMethod(method))
        throw new Error(`acp: ${JSON.stringify(method)} is declared as an extension method, and an extension method's name starts with "_"`);
  return erased;
};

export interface Split {
  /** The messages `before` handed over, and every message after them, on the same `write`. */
  readonly rest: Wire;
  /** Completes when the wire's `read` ends or fails. */
  readonly ended: Effect.Effect<void>;
}

/**
 * Reads `wire` in the background, passing each input to `before` until `before` returns `true`;
 * every input after that is kept for `rest`. `rest.read` ends when the wire's does, and fails when
 * it fails.
 */
export const split = (
  wire: Wire,
  before: (input: WireInput) => Effect.Effect<boolean>,
): Effect.Effect<Split, never, Scope.Scope> =>
  Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<WireInput, WireError | Cause.Done>();
    const ended = yield* Deferred.make<void>();
    let handedOver = false;
    yield* wire.read.pipe(
      Stream.runForEach((input) =>
        handedOver
          ? Queue.offer(inbox, input)
          : Effect.map(before(input), (done) => {
              handedOver = done;
            }),
      ),
      Effect.catch((error) => Queue.fail(inbox, error)),
      Effect.ensuring(Queue.end(inbox).pipe(Effect.andThen(Deferred.succeed(ended, undefined)))),
      Effect.forkScoped,
    );
    return { rest: { read: Stream.fromQueue(inbox), write: wire.write }, ended: Deferred.await(ended) };
  });

export interface Endpoint {
  // oxlint-disable-next-line typescript/no-explicit-any -- erased here, typed by the agent and the client
  readonly call: GatedClient<any>;
  // oxlint-disable-next-line typescript/no-explicit-any -- erased here, typed by the agent and the client
  readonly notify: GatedNotify<any>;
  // oxlint-disable-next-line typescript/no-explicit-any -- erased here, typed by the agent and the client
  readonly extensions: ExtensionClient<any, any>;
  /** Whether the connection is open (`Peer.open`): `false` once it is ending, before its handlers are interrupted. */
  readonly open: Effect.Effect<boolean>;
  /** Completes when the connection ends. */
  readonly closed: Effect.Effect<void>;
}

export interface StartOptions<V extends Version, R> {
  /** The wire after `initialize`. */
  readonly wire: Wire;
  readonly side: Side;
  readonly adapter: AnyAdapter;
  readonly profile: Profile<V>;
  readonly extensions: ErasedExtensions;
  /** The id of this end's first request through the peer: past those it sent before the peer started. */
  readonly firstId?: number | undefined;
  readonly handlers: (
    endpoint: Omit<Endpoint, "closed">,
  ) => Effect.Effect<Readonly<Record<string, AnyHandler<R> | undefined>>, never, R>;
}

type ErasedClient = Readonly<Record<string, (payload: unknown) => Effect.Effect<unknown, Methods.PeerClosed | JsonRpcError>>>;

/** Runs the peer for `side` on the negotiated version, until the wire ends or the scope closes. */
export const start = <V extends Version, R>(options: StartOptions<V, R>): Effect.Effect<Endpoint, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const { adapter, profile, side } = options;
    const incoming: Direction = side === "agent" ? "toAgent" : "toClient";
    const outgoing: Direction = side === "agent" ? "toClient" : "toAgent";
    const requests: Methods.MethodSet<Methods.Any> = side === "agent" ? adapter.agentRequests : adapter.clientRequests;
    const notifications: Methods.MethodSet<Methods.Any> =
      side === "agent" ? adapter.agentNotifications : adapter.clientNotifications;
    const versionCall: Methods.MethodSet<Methods.Any> =
      side === "agent" ? adapter.clientRequests : adapter.agentRequests.omit("initialize");
    const versionNotify: Methods.MethodSet<Methods.Any> =
      side === "agent" ? adapter.clientNotifications : adapter.agentNotifications;
    const { extensions } = options;
    const served = requests.add(
      ...notifications.omit(...requests.byName.keys()).byName.values(),
      ...extensions.serve.byName.values(),
    );
    const call = versionCall.add(...extensions.call.byName.values());
    const notify = versionNotify.add(...extensions.notify.byName.values());

    /** Runs `send` when the gate lets `method` with `payload` through; otherwise fails, having sent nothing. */
    const gated = <A, E>(
      method: string,
      payload: unknown,
      send: () => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | CapabilityNotAdvertised> => {
      const gate = adapter.gate(outgoing, method, payload, profile);
      if (gate._tag === "Allowed") return send();
      return Effect.logDebug(logKeys.gate.refusedLocally, { side, method, capability: gate.capability }).pipe(
        Effect.andThen(
          Effect.fail(new CapabilityNotAdvertised({ method, capability: gate.capability, message: gate.message })),
        ),
      );
    };

    let endpoint: Omit<Endpoint, "closed"> | undefined;
    const endpointOf = (peer: Peer.Peer<Methods.Any, Methods.Any>): Omit<Endpoint, "closed"> => {
      if (endpoint !== undefined) return endpoint;
      const client = peer.client as unknown as ErasedClient;
      const gatedCall = Object.fromEntries(
        [...versionCall.byName.keys()].map((method) => [
          method,
          (payload: unknown) =>
            gated(method, payload, () => client[method]?.(payload) ?? Effect.die(`no client method ${method}`)),
        ]),
      );
      const extensionCall = Object.fromEntries([...extensions.call.byName.keys()].map((method) => [method, client[method]]));
      endpoint = {
        call: gatedCall as never,
        notify: ((method: string, payload: unknown) =>
          gated(method, payload, () => peer.notify(method, payload as never))) as never,
        extensions: { call: extensionCall as never, notify: peer.notify as never },
        open: peer.open,
      };
      return endpoint;
    };

    /** Answers an incoming method: the gates first, then its handler, if it has one. */
    const handlerFor =
      (method: string, handlers: Readonly<Record<string, AnyHandler<R> | undefined>>) =>
      (payload: unknown): Effect.Effect<unknown, JsonRpcError, R> => {
        if (side === "agent" && method === "initialize")
          return Effect.fail({
            code: ErrorCode.InvalidRequest,
            message: "The connection is already initialized",
            data: { reason: "already_initialized" },
          });
        const gate = adapter.gate(incoming, method, payload, profile);
        if (gate._tag === "Refused") {
          const error = refusalError(gate);
          return Effect.logInfo(logKeys.gate.refusedIncoming, {
            side,
            method,
            capability: gate.capability,
            code: error.code,
          }).pipe(Effect.andThen(Effect.fail(error)));
        }
        const handler = handlers[method];
        if (handler === undefined)
          return Effect.fail({ code: ErrorCode.MethodNotFound, message: `Method not found: ${method}` });
        return handler(payload as never);
      };

    // The sets are erased here; what the handlers need is `R`, the services the caller's handlers need.
    const running = Peer.make({
      wire: options.wire,
      serve: served,
      call,
      notify,
      firstId: options.firstId,
      handlers: (peer) =>
        Effect.map(options.handlers(endpointOf(peer)), (handlers) =>
          Object.fromEntries([...served.byName.keys()].map((method) => [method, handlerFor(method, handlers)])),
        ) as never,
    }) as Effect.Effect<Peer.Peer<Methods.Any, Methods.Any>, never, Scope.Scope | R>;
    const peer = yield* running;
    return { ...endpointOf(peer), closed: peer.closed };
  });
