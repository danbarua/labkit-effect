/**
 * What a plug-in is: a name (`use`, its key in a configuration file), a Schema for its settings
 * with a default for every setting that has one (a budget has none), the seams it adds to, and the entries it adds to them, given
 * its settings and what the host says (`HostSays`).
 *
 * A seam is one of the ordered lists a session's logic plugs into (`agent-session`): the tool call
 * policies, the model request policies, the turn-end hooks, what is known of models, how settings
 * are applied for a provider, and the tool sources. A plug-in on two seams is listed in each.
 */

import type { EnvironmentTransform } from "../agent-process/environment.ts";
import type { Effect, Schema, Scope } from "effect";
import type { SettlingSource } from "../agent-session/configuration/options.ts";
import type { ModelKnowledge } from "../agent-session/configuration/well-known-models.ts";
import type { PolicyOfFacts, TurnEndHook } from "../agent-session/contracts.ts";
import type { ToolSource } from "../agent-session/tool-sources.ts";

/** One entry of each seam, as a plug-in adds it. */
export interface Entries {
  readonly toolCalls: PolicyOfFacts;
  readonly modelRequests: PolicyOfFacts;
  readonly turnEnd: TurnEndHook;
  readonly knownModels: ModelKnowledge;
  readonly settling: SettlingSource;
  /** A source started in the session's scope (an MCP server's, say). */
  readonly toolSources: Effect.Effect<ToolSource, never, Scope.Scope>;
  /** What a command the model runs is given of the environment (`agent-process` `EnvironmentTransform`). */
  readonly commandEnvironment: EnvironmentTransform;
}

export type Seam = keyof Entries;

/** The seams, in the order a file lists them. */
export const seams: ReadonlyArray<Seam> = ["toolCalls", "modelRequests", "turnEnd", "knownModels", "settling", "toolSources", "commandEnvironment"];

/** What the host says, that a file does not: whether anyone is there to answer a question before a call runs. */
export interface HostSays {
  readonly canAsk: boolean;
}

/** A plug-in's settings: a struct, each of its settings with a default (`Schema.withDecodingDefaultKey`). */
export type Settings = Schema.Struct<Schema.Struct.Fields>;

export interface Plugin<S extends Settings = Settings, On extends Seam = Seam> {
  readonly use: string;
  readonly settings: S;
  readonly on: ReadonlyArray<On>;
  readonly entries: (settings: S["Type"], host: HostSays) => Pick<Entries, On>;
}

/** A plug-in named `use`, on the seams `on`. */
export const plugin = <S extends Settings, const On extends Seam>(
  use: string,
  settings: S,
  on: ReadonlyArray<On>,
  entries: (settings: S["Type"], host: HostSays) => Pick<Entries, On>,
): Plugin<S, On> => ({ use, settings, on, entries });

/** A plug-in with its settings and seams erased, as a registry holds it: its entries are asked for with settings its own Schema decoded. */
export interface AnyPlugin {
  readonly use: string;
  readonly settings: Schema.Top & { readonly fields: Schema.Struct.Fields; readonly DecodingServices: never };
  readonly on: ReadonlyArray<Seam>;
  readonly entries: (settings: never, host: HostSays) => Partial<Entries>;
}
