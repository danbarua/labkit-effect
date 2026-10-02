/** What a session runs with, given the host's tools, and the permission policy for a mode. */

import { Effect, Layer } from "effect";
import { AgentContextAssembler, WholeConversation } from "../agent-context/assembler.ts";
import { Notices } from "../agent-context/assemble.ts";
import { type PermissionMode, permissions } from "../agent-policy/permissions.ts";
import type { Policy } from "../agent-policy/policy.ts";
import { ToolCallPolicy, type ToolRunner, type TurnEndHooks } from "../agent-session/contracts.ts";
import { ModelFromFacts } from "../agent-session/configuration/model-choice.ts";
import { immutableToolCatalogOf } from "../agent-session/configuration/session-setup.ts";
import { CountingTurnsInStore, NoTurnEndHooks } from "../agent-session/turns.ts";
import { Clients } from "./clients.ts";
import { KnownWithLocalServer, SettlingWithLocalServer } from "./local-server.ts";

/**
 * What the loop needs for a session, but its store and its permission policy: the model its facts
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
 */
export const PermissionsFor = (mode: PermissionMode, canAsk: boolean) =>
  Layer.succeed(ToolCallPolicy, (facts) =>
    Effect.map(immutableToolCatalogOf(facts), (tools) => permissions(mode, canAsk, (name) => tools.find((tool) => tool.name === name)?.kind, facts) as Policy<unknown>),
  );
