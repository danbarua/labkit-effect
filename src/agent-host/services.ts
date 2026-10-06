/** The services that a session runs with, given the host's tools, and the policies that a host puts in its lists. */

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
import { costIn } from "../agent-session/accounting.ts";
import { receivedJson } from "../agent-session/received.ts";
import { CountedToolRunner } from "../instrumentation/tool-metrics.ts";
import { Clients } from "./clients.ts";
import { KnownWithLocalServer, SettlingWithLocalServer } from "./local-server.ts";

/**
 * What the loop needs for a session, except its store, its policies and its turn-end hooks: the
 * model that the facts name, what is known of it and how its settings are applied, the whole
 * conversation as context with the notices from the context that the layer is built in (`Notices`:
 * none unless the host provides them), the provider clients, turn identities that continue from
 * those the store holds, and `runner` for its tools, each run counted and timed.
 */
export const SessionServices = <E, R>(runner: Layer.Layer<ToolRunner, E, R>) =>
  Layer.mergeAll(
    ModelFromFacts.pipe(Layer.provide(KnownWithLocalServer)),
    KnownWithLocalServer,
    SettlingWithLocalServer,
    AgentContextAssembler.pipe(Layer.provide(WholeConversation)),
    Clients,
    CountingTurnsInStore,
    // Each tool run is counted and timed (`instrumentation/tool-metrics.ts`), which OTLP sends when it is set up.
    CountedToolRunner(runner),
  );

/**
 * The permission policy for `mode`, over the tools that the session opened with: each call is judged
 * by its tool's kind. `canAsk` is whether anyone can answer a question before a call runs. `mode` is
 * read at each call, so a host that lets the user change it applies the change from the next call.
 * A tool call policy (`ToolCallPolicies`).
 */
export const permissionsFor =
  (mode: PermissionMode | Effect.Effect<PermissionMode>, canAsk: boolean): PolicyOfFacts =>
  (facts) =>
    Effect.flatMap(immutableToolCatalogOf(facts), (tools) =>
      Effect.map(
        Effect.isEffect(mode) ? mode : Effect.succeed(mode),
        (now) => permissions(now, canAsk, (name) => tools.find((tool) => tool.name === name)?.kind, facts) as Policy<unknown>,
      ),
    );

/** The limit on a turn's model requests (`agent-policy/max-turn-requests.ts`), 1000 when not given. A model request policy. */
export const turnRequestLimit =
  (limit?: number): PolicyOfFacts =>
  (facts) =>
    Effect.succeed(maxTurnRequests(facts, limit));

/**
 * A budget for a session, in US dollars: once the session has cost `usd` or more, a model request is
 * vetoed, which ends its turn. The cost is the responses' cost (`costIn`); a model with no known price
 * (a local one) costs nothing. A model request policy.
 */
export const budgetLimit =
  (usd: number): PolicyOfFacts =>
  (facts) =>
    Effect.sync((): Policy<unknown> => {
      const spent = costIn(facts);
      return {
        start: (request) =>
          request._tag === "RequestModelResponse" && spent >= usd
            ? { _tag: "Decided", verdict: { _tag: "Veto", reason: receivedJson({ stop: "max_budget_usd", usd, spent: Math.round(spent * 1e6) / 1e6 }) } }
            : { _tag: "Decided", verdict: { _tag: "Continue" } },
        receive: () => ({ _tag: "Decided", verdict: { _tag: "Continue" } }),
      };
    });

/** The loop breaker's two policies (`agent-policy/loop-breaker.ts`): one on tool calls, one on model requests. */
export const loopBreaker = (settings: LoopBreakerSettings = loopBreakerDefaults) => ({
  toolCalls: ((facts) => Effect.succeed(repeatedCalls(facts, settings))) satisfies PolicyOfFacts,
  modelRequests: ((facts) => Effect.succeed(repeatingTurns(facts, settings))) satisfies PolicyOfFacts,
});
