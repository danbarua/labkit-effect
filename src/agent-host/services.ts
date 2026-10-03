/** What a session runs with, given the host's tools, and the policies a host puts in its lists. */

import { Effect, Layer } from "effect";
import { AgentContextAssembler, WholeConversation } from "../agent-context/assembler.ts";
import { Notices } from "../agent-context/assemble.ts";
import { type PermissionMode, permissions } from "../agent-policy/permissions.ts";
import { type LoopBreakerSettings, loopBreakerDefaults, repeatedCalls, repeatingTurns } from "../agent-policy/loop-breaker.ts";
import type { Policy } from "../agent-policy/policy.ts";
import type { PolicyOfFacts, ToolRunner, TurnEndHooks } from "../agent-session/contracts.ts";
import { ModelFromFacts } from "../agent-session/configuration/model-choice.ts";
import { immutableToolCatalogOf } from "../agent-session/configuration/session-setup.ts";
import { CountingTurnsInStore, NoTurnEndHooks } from "../agent-session/turns.ts";
import { Clients } from "./clients.ts";
import { KnownWithLocalServer, SettlingWithLocalServer } from "./local-server.ts";

/**
 * What the loop needs for a session, but its store and its policies: the model its facts
 * name, what is known of it and how its settings are applied, the whole conversation as context,
 * the provider clients, turns that count on from those the store holds, `runner` for its tools, and
 * `hooks` before a turn ends (none when left out).
 */
export const SessionServices = <E, R, HE = never, HR = never>(
  runner: Layer.Layer<ToolRunner, E, R>,
  hooks: Layer.Layer<TurnEndHooks, HE, HR> = NoTurnEndHooks as Layer.Layer<TurnEndHooks, HE, HR>,
) =>
  Layer.mergeAll(
    ModelFromFacts.pipe(Layer.provide(KnownWithLocalServer)),
    KnownWithLocalServer,
    SettlingWithLocalServer,
    AgentContextAssembler.pipe(Layer.provide(Layer.mergeAll(WholeConversation, Layer.succeed(Notices, [])))),
    Clients,
    CountingTurnsInStore,
    hooks,
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

/** The loop breaker's two policies (`agent-policy/loop-breaker.ts`): one on tool calls, one on model requests. */
export const loopBreaker = (settings: LoopBreakerSettings = loopBreakerDefaults) => ({
  toolCalls: ((facts) => Effect.succeed(repeatedCalls(facts, settings))) satisfies PolicyOfFacts,
  modelRequests: ((facts) => Effect.succeed(repeatingTurns(facts, settings))) satisfies PolicyOfFacts,
});
