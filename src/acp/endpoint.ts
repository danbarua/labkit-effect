/**
 * What the agent and the client share once `initialize` is answered: the peer on the negotiated
 * version's method groups, with each side's capability gates in front of it.
 *
 * - `split` reads a wire through `before` until `before` hands it over (when `initialize` is
 *   answered); every later message is kept for the peer, so none is lost while it starts.
 * - `start` runs the peer. An incoming request a gate refuses is answered -32601 or -32602 naming
 *   the capability, and an incoming notification it refuses is dropped, both before any handler
 *   runs. An outgoing request or notification a gate refuses fails with `CapabilityNotAdvertised`
 *   and nothing is sent.
 */

import { type Cause, Deferred, Effect, Layer, Queue, type Scope, Stream } from "effect";
import type { Rpc, RpcClient, RpcClientError, RpcGroup } from "effect/rpc";
import { ErrorCode, type JsonRpcError, type Wire, type WireError, type WireInput } from "./json-rpc.ts";
import { logKeys } from "./log-keys.ts";
import * as Peer from "./peer.ts";
import {
  type AnyAdapter,
  CapabilityNotAdvertised,
  type Direction,
  type Profile,
  refusalError,
  type Version,
} from "./protocol.ts";

/** Which end of the connection this is. */
export type Side = "agent" | "client";

/** A handler of a method this end serves, its payload erased; `R` is the services it needs. */
export type AnyHandler<R> = (payload: never) => Effect.Effect<unknown, JsonRpcError, R>;

/** Handlers by method name, typed by one version's group of methods; any subset of them. */
export type Handlers<Rpcs extends Rpc.Any, R> = {
  readonly [Current in Rpcs as Current["_tag"]]?: (
    payload: Rpc.Payload<Current>,
  ) => Effect.Effect<Rpc.Success<Current>, JsonRpcError, R>;
};

/** The methods one end serves: its requests, and the notifications that are not also requests (`mcp/message` is both). */
export type Served<Requests extends Rpc.Any, Notifications extends Rpc.Any> =
  | Requests
  | Exclude<Notifications, { readonly _tag: Requests["_tag"] }>;

/** The other end's requests, called through the gates. */
export type GatedClient<Rpcs extends Rpc.Any> = RpcClient.RpcClient<
  Rpcs,
  RpcClientError.RpcClientError | CapabilityNotAdvertised
>;

/** Sends one of the other end's notifications through the gates. */
export type GatedNotify<Rpcs extends Rpc.Any> = <Tag extends Rpcs["_tag"]>(
  tag: Tag,
  payload: Rpc.Payload<Rpc.ExtractTag<Rpcs, Tag>>,
) => Effect.Effect<void, CapabilityNotAdvertised>;

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
  /** Completes when the connection ends. */
  readonly closed: Effect.Effect<void>;
}

export interface StartOptions<V extends Version, R> {
  /** The wire after `initialize`. */
  readonly wire: Wire;
  readonly side: Side;
  readonly adapter: AnyAdapter;
  readonly profile: Profile<V>;
  readonly handlers: (
    endpoint: Omit<Endpoint, "closed">,
  ) => Effect.Effect<Readonly<Record<string, AnyHandler<R> | undefined>>, never, R>;
}

type ErasedClient = Readonly<
  Record<
    string,
    (payload: unknown, options?: unknown) => Effect.Effect<unknown, RpcClientError.RpcClientError | JsonRpcError>
  >
>;

/** Runs the peer for `side` on the negotiated version, until the wire ends or the scope closes. */
export const start = <V extends Version, R>(options: StartOptions<V, R>): Effect.Effect<Endpoint, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const { adapter, profile, side } = options;
    const incoming: Direction = side === "agent" ? "toAgent" : "toClient";
    const outgoing: Direction = side === "agent" ? "toClient" : "toAgent";
    const requests: RpcGroup.RpcGroup<Rpc.Any> = side === "agent" ? adapter.agentRequests : adapter.clientRequests;
    const notifications: RpcGroup.RpcGroup<Rpc.Any> =
      side === "agent" ? adapter.agentNotifications : adapter.clientNotifications;
    const served = requests.merge(notifications.omit(...requests.requests.keys()));
    const call: RpcGroup.RpcGroup<Rpc.Any> =
      side === "agent" ? adapter.clientRequests : adapter.agentRequests.omit("initialize");
    const notify: RpcGroup.RpcGroup<Rpc.Any> = side === "agent" ? adapter.clientNotifications : adapter.agentNotifications;

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
    const endpointOf = (peer: Peer.Peer<Rpc.Any, Rpc.Any>): Omit<Endpoint, "closed"> => {
      if (endpoint !== undefined) return endpoint;
      const client = peer.client as unknown as ErasedClient;
      const gatedCall = Object.fromEntries(
        [...call.requests.keys()].map((method) => [
          method,
          (payload: unknown, callOptions?: unknown) =>
            gated(method, payload, () => client[method]?.(payload, callOptions) ?? Effect.die(`no client method ${method}`)),
        ]),
      );
      endpoint = {
        call: gatedCall as never,
        notify: ((method: string, payload: unknown) =>
          gated(method, payload, () => peer.notify(method, payload as never))) as never,
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

    // The groups are erased here; what the handlers need is `R`, the services the caller's handlers need.
    const running = Peer.make({
      wire: options.wire,
      serve: served,
      call,
      notify,
      handlers: (peer) =>
        Layer.effectContext(
          Effect.gen(function* () {
            const handlers = yield* options.handlers(endpointOf(peer));
            const wrapped = Object.fromEntries([...served.requests.keys()].map((method) => [method, handlerFor(method, handlers)]));
            return yield* served.toHandlers(Effect.succeed(wrapped) as never);
          }),
        ) as never,
    }) as Effect.Effect<Peer.Peer<Rpc.Any, Rpc.Any>, never, Scope.Scope | R>;
    const peer = yield* running;
    return { ...endpointOf(peer), closed: peer.closed };
  });
