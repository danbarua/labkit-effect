/**
 * JSON-RPC methods as ACP declares them: each one's name and the schema of its params, and for a
 * request the schema of its result. Every request's error is `JsonRpcError`; ACP has no
 * per-method error type, so no method declares one.
 *
 * A method set (`make`) holds methods by name. `omit` and `add` make new sets, and each method's
 * name stays a literal in the types. `Handlers`, `Caller` and `Notify` type what serves a set,
 * what calls its requests and what sends its notifications.
 */

import { Data, type Effect, type Schema } from "effect";
import type { JsonRpcError } from "./json-rpc.ts";

export interface Request<Name extends string = string, Params extends Schema.Top = Schema.Top, Result extends Schema.Top = Schema.Top> {
  readonly _tag: "Request";
  readonly name: Name;
  readonly params: Params;
  readonly result: Result;
}

export interface Notification<Name extends string = string, Params extends Schema.Top = Schema.Top> {
  readonly _tag: "Notification";
  readonly name: Name;
  readonly params: Params;
}

export type Any = Request | Notification;

/** A request named `name`, its params decoded by `params` and its result by `result`. */
export const request = <const Name extends string, Params extends Schema.Top, Result extends Schema.Top>(
  name: Name,
  params: Params,
  result: Result,
): Request<Name, Params, Result> => ({ _tag: "Request", name, params, result });

/** A notification named `name`, its params decoded by `params`. */
export const notification = <const Name extends string, Params extends Schema.Top>(
  name: Name,
  params: Params,
): Notification<Name, Params> => ({ _tag: "Notification", name, params });

/** Methods by name. */
export interface MethodSet<M extends Any> {
  readonly byName: ReadonlyMap<string, M>;
  /** This set without the methods named. */
  readonly omit: <const Names extends ReadonlyArray<M["name"]>>(...names: Names) => MethodSet<Exclude<M, { readonly name: Names[number] }>>;
  /** This set with `methods` too; one named as a method already here replaces it. */
  readonly add: <const Added extends ReadonlyArray<Any>>(...methods: Added) => MethodSet<M | Added[number]>;
}

/** The set of `methods`; of two with one name, the later one is kept. */
export const make = <const Methods extends ReadonlyArray<Any>>(...methods: Methods): MethodSet<Methods[number]> => ({
  byName: new Map(methods.map((method) => [method.name, method])),
  omit: (...names) => make(...methods.filter((method) => !names.includes(method.name))) as never,
  add: (...added) => make(...methods, ...added),
});

/** The methods of a set. */
export type Of<Set> = Set extends MethodSet<infer M> ? M : never;

/** The method of `M` named `Name`. */
export type Named<M extends Any, Name extends string> = Extract<M, { readonly name: Name }>;

/** A method's params, decoded. */
export type Params<M extends Any> = M["params"]["Type"];

/** A request's result, decoded; a notification has none. */
export type Result<M extends Any> = M extends Request<string, Schema.Top, infer R> ? R["Type"] : void;

/**
 * One handler per method of `M`, by name. A request's handler returns its result and a
 * notification's returns nothing; either fails with the `JsonRpcError` its request is answered
 * with. Keyed by name, not mapped over the methods, so that a handler record never decides `M`.
 */
export type Handlers<M extends Any, R> = {
  readonly [Name in M["name"]]: (params: Params<Named<M, Name>>) => Effect.Effect<Result<Named<M, Name>>, JsonRpcError, R>;
};

/** A call to the other end got no answer: the connection closed first, or the request could not be written. */
export class PeerClosed extends Data.TaggedError("PeerClosed")<{
  readonly reason: string;
}> {}

/**
 * Calls to the requests of `M`, by name. A call fails with the `JsonRpcError` the other end answers,
 * with `PeerClosed` when it gets no answer, and with `E`.
 */
export type Caller<M extends Any, E = never> = {
  readonly [Name in Extract<M, Request>["name"]]: (
    params: Named<Extract<M, Request>, Name>["params"]["~type.make.in"],
  ) => Effect.Effect<Result<Named<Extract<M, Request>, Name>>, JsonRpcError | PeerClosed | E>;
};

/** Sends one of the notifications of `M`; it fails only with `E`. */
export type Notify<M extends Any, E = never> = <Name extends M["name"]>(
  name: Name,
  params: Params<Named<M, Name>>,
) => Effect.Effect<void, E>;
