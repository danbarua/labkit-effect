/**
 * The seam lists that a decoded configuration gives a session: each seam's entries, in order, made
 * by their plug-ins from their settings and what the host provides, and the layer that provides
 * them. A seam that the configuration does not list is not provided, so the host's own list, or the
 * seam's default, applies.
 */

import { Effect, Layer } from "effect";
import { EntryName } from "../agent-machine/names.ts";
import { Settling, type SettlingSource } from "../agent-session/configuration/options.ts";
import { KnownModels, type ModelKnowledge } from "../agent-session/configuration/well-known-models.ts";
import { MaxHolds, ModelRequestPolicies, type NamedPolicy, ToolCallPolicies, type TurnEndHook, TurnEndHooks } from "../agent-session/contracts.ts";
import { ToolSources } from "../agent-session/tool-sources.ts";
import type { Configuration } from "./file.ts";
import type { Entries, FromHost, Seam } from "./plugin.ts";

/** Each seam that the configuration lists, as the session's list for it, and `maxHolds` when the configuration gives it. */
export interface SeamLists {
  readonly toolCalls?: ReadonlyArray<NamedPolicy>;
  readonly modelRequests?: ReadonlyArray<NamedPolicy>;
  readonly turnEnd?: ReadonlyArray<TurnEndHook>;
  readonly knownModels?: ReadonlyArray<ModelKnowledge>;
  readonly settling?: ReadonlyArray<SettlingSource>;
  readonly toolSources?: ReadonlyArray<Entries["toolSources"]>;
  /** Not a context seam: the host's builder applies these transforms once, to make the session's environment (`agent-host/session-context.ts`). */
  readonly commandEnvironment?: ReadonlyArray<Entries["commandEnvironment"]>;
  readonly maxHolds?: number;
}

/** Returns the entries of `seam` that the configuration lists, in order; undefined when it does not list the seam. */
const listOf = <S extends Seam>(configuration: Configuration, seam: S, host: FromHost): ReadonlyArray<Entries[S]> | undefined =>
  configuration.lists[seam]?.map((entry) => {
    // oxlint-disable-next-line abstract/no-double-cast -- `AnyPlugin` erases each plug-in's settings type, so `entries` takes `never`; `entry.settings` was decoded by this same plug-in's schema (`agent-config/file.ts`). Binding the settings at decode time would remove the cast.
    const made = entry.plugin.entries(entry.settings as never, host, EntryName.make(entry.name))[seam];
    // A plug-in is registered on a seam only when it says so (`on`), and its entries are typed by it.
    if (made === undefined) throw new Error(`${entry.plugin.use} is listed on ${seam} but gives it no entry`);
    return made as Entries[S];
  });

/** Returns the policies that `seam` lists, each under the name it is listed by. */
const namedListOf = (configuration: Configuration, seam: "toolCalls" | "modelRequests", host: FromHost): ReadonlyArray<NamedPolicy> | undefined => {
  const made = listOf(configuration, seam, host);
  const names = configuration.lists[seam] ?? [];
  return made?.map((policy, index) => ({ name: names[index]?.name ?? "", policy }));
};

/** Returns the seam lists of `configuration`, given what the host provides. */
export const seamListsOf = (configuration: Configuration, host: FromHost): SeamLists => {
  const lists = {
    toolCalls: namedListOf(configuration, "toolCalls", host),
    modelRequests: namedListOf(configuration, "modelRequests", host),
    turnEnd: listOf(configuration, "turnEnd", host),
    knownModels: listOf(configuration, "knownModels", host),
    settling: listOf(configuration, "settling", host),
    toolSources: listOf(configuration, "toolSources", host),
    commandEnvironment: listOf(configuration, "commandEnvironment", host),
    maxHolds: configuration.maxHolds,
  };
  return Object.fromEntries(Object.entries(lists).filter(([, value]) => value !== undefined));
};

/** Returns the layer that provides each of `lists`. A seam that `lists` does not have keeps the host's list or its default. */
export const seamLayer = (lists: SeamLists): Layer.Layer<never> => {
  const provided: ReadonlyArray<Layer.Layer<never> | undefined> = [
    lists.toolCalls && Layer.succeed(ToolCallPolicies, lists.toolCalls),
    lists.modelRequests && Layer.succeed(ModelRequestPolicies, lists.modelRequests),
    lists.turnEnd && Layer.succeed(TurnEndHooks, lists.turnEnd),
    lists.maxHolds === undefined ? undefined : Layer.succeed(MaxHolds, lists.maxHolds),
    lists.knownModels && Layer.succeed(KnownModels, lists.knownModels),
    lists.settling && Layer.succeed(Settling, lists.settling),
    lists.toolSources && Layer.effect(ToolSources, Effect.all(lists.toolSources)),
  ];
  return provided.reduce<Layer.Layer<never>>((all, layer) => (layer === undefined ? all : Layer.merge(all, layer)), Layer.empty);
};
