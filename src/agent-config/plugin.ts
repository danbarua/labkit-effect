/**
 * What a plug-in is: a name (`use`, its key in a configuration file), a Schema for its settings with
 * a default for every setting that has one (a budget has none), the seams it adds to, and a function
 * that makes its entries from its settings, what the host provides (`FromHost`), and the name that
 * the configuration lists the entry by.
 *
 * A seam is one of the ordered lists that a session's logic plugs into (`agent-session`): the tool
 * call policies, the model request policies, the turn-end hooks, what is known of models, how
 * settings are applied for a provider, the tool sources, and the command environment. A plug-in on
 * two seams is listed in each.
 */

import type { EntryName } from "../agent-machine/names.ts";
import type { EnvironmentTransform } from "../agent-process/environment.ts";
import type { PermissionMode } from "../agent-policy/permissions.ts";
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
  /** A source started in the session's scope (an MCP server's, for example). */
  readonly toolSources: Effect.Effect<ToolSource, never, Scope.Scope>;
  /** A transform of the session's environment, which the model's commands and the MCP servers receive (`agent-process` `EnvironmentTransform`). */
  readonly commandEnvironment: EnvironmentTransform;
}

export type Seam = keyof Entries;

/** The seams, in the order that a file lists them. */
export const seams: ReadonlyArray<Seam> = ["toolCalls", "modelRequests", "turnEnd", "knownModels", "settling", "toolSources", "commandEnvironment"];

/**
 * What the host provides that a file cannot: whether anyone can answer a question before a call
 * runs, and, where the user changes the permission mode during a session, the current mode. The
 * session's id and folders are not here: an entry reads them at each call from the context of the
 * session it runs in (`agent-environment/session-context.ts`).
 */
export interface FromHost {
  readonly canAsk: boolean;
  /** The session's current permission mode, read at each call; the configured `mode` is the mode that the session starts in. */
  readonly permissionMode?: Effect.Effect<PermissionMode> | undefined;
  /**
   * The names of a tool's path inputs, from the tools the session runs with now; the permission
   * policy judges those paths. A tool it does not name falls back to the session's recorded catalog
   * (`ToolSpec.paths`), which a session recorded before path inputs were named lacks.
   */
  readonly toolPaths?: ((tool: string) => ReadonlyArray<string> | undefined) | undefined;
}

/** A plug-in's settings: a struct, each of its settings with a default (`Schema.withDecodingDefaultKey`). */
export type Settings = Schema.Struct<Schema.Struct.Fields>;

export interface Plugin<S extends Settings = Settings, On extends Seam = Seam> {
  readonly use: string;
  readonly settings: S;
  readonly on: ReadonlyArray<On>;
  readonly entries: (settings: S["Type"], host: FromHost, name: EntryName) => Pick<Entries, On>;
}

/** Returns a plug-in named `use`, on the seams `on`. */
export const plugin = <S extends Settings, const On extends Seam>(
  use: string,
  settings: S,
  on: ReadonlyArray<On>,
  entries: (settings: S["Type"], host: FromHost, name: EntryName) => Pick<Entries, On>,
): Plugin<S, On> => ({ use, settings, on, entries });

/** A plug-in with its settings and seams types erased, as a registry holds it. Its entries are made with settings that its own Schema decoded. */
export interface AnyPlugin {
  readonly use: string;
  readonly settings: Schema.Top & { readonly fields: Schema.Struct.Fields; readonly DecodingServices: never };
  readonly on: ReadonlyArray<Seam>;
  readonly entries: (settings: never, host: FromHost, name: EntryName) => Partial<Entries>;
}
