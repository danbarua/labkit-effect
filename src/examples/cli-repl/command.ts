/**
 * A REPL command: a line starting with the command's name (`/model`), which the REPL runs instead of
 * sending the line to the model. The commands are listed in `commands.ts`; each is written in its own
 * file in `commands/` against this contract.
 *
 * A command runs in a session (`inSession`). Before a model is picked there is no session (the REPL
 * without a model, `repl.ts`): a command runs there only if it defines `withoutModel`, and any other
 * command is refused until a model is picked.
 */

import type { Effect, FileSystem, Path, Terminal } from "effect";
import type { CliError } from "effect/cli";
import type { LayerSource } from "../../agent-config/file.ts";
import type { SettingsChange } from "../../agent-machine/settings.ts";
import type { Asked, ModelCatalog } from "../../agent-host/catalog.ts";
import type { McpServers } from "../../agent-mcp/servers.ts";
import type { Services, Session } from "../../agent-session/loop.ts";
import type { SessionStoreFailed } from "../../agent-session/session-store.ts";
import type { SettingOption } from "../../agent-session/configuration/options.ts";
import type { View } from "./view.ts";

/** What a command runs with besides its words. */
export interface CommandContext {
  /** The working folder; `/export` writes under it. */
  readonly folder: string;
  /** The user's configuration folder; `/model` and `/settings` save settings into it. */
  readonly configFolder: string;
  /** What the REPL shows; `/settings` changes it. */
  readonly view: View;
  /** The configuration's layers, in order; a layer after the user's folder can override what a command saves there. */
  readonly layers: ReadonlyArray<LayerSource>;
  /**
   * The settings given on the command line. A session opened before a model is picked opens with
   * them, so `/model` and `/switch` pick only a model that supports them.
   */
  readonly commandLine: SettingsChange;
  /** The session's MCP servers; absent when the session has none. */
  readonly mcp?: McpServers;
}

/** What completion draws on: the usable models, the current model's settings, and the session's MCP server names. */
export interface Offered {
  readonly models: ReadonlyArray<string>;
  readonly settings: ReadonlyArray<SettingOption>;
  readonly servers: ReadonlyArray<string>;
}

/** What a command did: text for the REPL to print, nothing to print, or the REPL to end. */
export type Done = { readonly _tag: "Said"; readonly text: string } | { readonly _tag: "Quiet" } | { readonly _tag: "Exit" };

/** What a command did before a model is picked: as in a session, or the picked model, with text to print first. */
export type DoneWithoutModel = Done | { readonly _tag: "Picked"; readonly target: Asked; readonly text?: string };

/** The outcome of a command that prints `text`. */
export const said = (text: string): Done => ({ _tag: "Said", text });

/** The services commands need: the terminal for pickers, the file system, and the model catalog; in a session, also the loop's services. */
export type Needs = Terminal.Terminal | FileSystem.FileSystem | Path.Path | ModelCatalog;

/** A command's error, shown to the user (`invalid.ts`); the user cancelling a picker (Ctrl+C); or the session store failing to record a change. */
export type Failure = CliError.UserError | Terminal.QuitError | SessionStoreFailed;

export interface ReplCommand {
  /** The command's name, as typed. */
  readonly name: `/${string}`;
  /** Other names for the command. */
  readonly aliases?: ReadonlyArray<`/${string}`>;
  /** The arguments, as `/help` shows them (`[name]`); absent when the command takes none. */
  readonly args?: string;
  /** The command's description in `/help`. */
  readonly says: string;
  /** Completions for the line's words (the name first); absent when the command completes nothing. */
  readonly complete?: (words: ReadonlyArray<string>, from: Offered) => ReadonlyArray<string>;
  /** Runs the command in `session` with the words after its name. */
  readonly inSession: (session: Session, words: ReadonlyArray<string>, context: CommandContext) => Effect.Effect<Done, Failure, Needs | Services>;
  /** Runs the command before a model is picked; a command without it is refused until then. */
  readonly withoutModel?: (words: ReadonlyArray<string>, context: CommandContext) => Effect.Effect<DoneWithoutModel, Failure, Needs>;
}
