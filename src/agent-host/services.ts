/** What a session runs with, given the host's tools, and the policies a host puts in its lists. */

import { Effect, Layer } from "effect";
import { AgentContextAssembler, WholeConversation } from "../agent-context/assembler.ts";
import { type PermissionMode, permissions } from "../agent-policy/permissions.ts";
import { type LoopBreakerSettings, loopBreakerDefaults, repeatedCalls, repeatingTurns } from "../agent-policy/loop-breaker.ts";
import { maxTurnRequests } from "../agent-policy/max-turn-requests.ts";
import type { Policy } from "../agent-policy/policy.ts";
import type { PolicyOfFacts, ToolRunner } from "../agent-session/contracts.ts";
import { ModelFromFacts } from "../agent-session/configuration/model-choice.ts";
import { immutableToolCatalogOf } from "../agent-session/configuration/session-setup.ts";
import { CountingTurnsInStore } from "../agent-session/turns.ts";
import { Clients } from "./clients.ts";
import { KnownWithLocalServer, SettlingWithLocalServer } from "./local-server.ts";

/**
 * What the loop needs for a session, but its store, its policies and its turn-end hooks: the model
 * its facts name, what is known of it and how its settings are applied, the whole conversation as
 * context, with the notices of the context the layer is built in (`Notices`: none unless the host
 * provides them), the provider clients, turns that count on from those the store holds, and
 * `runner` for its tools.
 */
export const SessionServices = <E, R>(runner: Layer.Layer<ToolRunner, E, R>) =>
  Layer.mergeAll(
    ModelFromFacts.pipe(Layer.provide(KnownWithLocalServer)),
    KnownWithLocalServer,
    SettlingWithLocalServer,
    AgentContextAssembler.pipe(Layer.provide(WholeConversation)),
    Clients,
    CountingTurnsInStore,
    runner,
  );

/**
 * The permission policy for `mode`, over the tools the session opened with: each call is judged by
 * its tool's kind. `canAsk` says whether anyone is there to answer a question before a call runs.
 * `mode` is read at each call, so a host that lets the user change it applies the change from the
 * next call. A tool call policy (`ToolCallPolicies`).
 */
export const permissionsFor =
  (mode: PermissionMode | (() => PermissionMode), canAsk: boolean): PolicyOfFacts =>
  (facts) =>
    Effect.map(
      immutableToolCatalogOf(facts),
      (tools) => permissions(typeof mode === "function" ? mode() : mode, canAsk, (name) => tools.find((tool) => tool.name === name)?.kind, facts) as Policy<unknown>,
    );

/** The limit on a turn's model requests (`agent-policy/max-turn-requests.ts`), 1000 when not given: a model request policy. */
export const turnRequestLimit =
  (limit?: number): PolicyOfFacts =>
  (facts) =>
    Effect.succeed(maxTurnRequests(facts, limit));

/** The loop breaker's two policies (`agent-policy/loop-breaker.ts`): one on tool calls, one on model requests. */
export const loopBreaker = (settings: LoopBreakerSettings = loopBreakerDefaults) => ({
  toolCalls: ((facts) => Effect.succeed(repeatedCalls(facts, settings))) satisfies PolicyOfFacts,
  modelRequests: ((facts) => Effect.succeed(repeatingTurns(facts, settings))) satisfies PolicyOfFacts,
});
