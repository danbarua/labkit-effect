/**
 * A REPL command: a line that starts with the command's name (`/model`), which the REPL runs instead
 * of sending the line to the model. The REPL's commands are a list (`commands.ts`). A command is
 * added by writing it in its own file in `commands/`, against this contract, and listing it there.
 *
 * A command runs in a session (`inSession`). Before a model is picked there is no session (the REPL
 * without a model, `repl.ts`), and a command runs there only when it says what it does without one
 * (`withoutModel`); any other command is refused until a model is picked.
 */

import type { Effect, FileSystem, Path, Terminal } from "effect";
import type { CliError } from "effect/cli";
import type { LayerSource } from "../../agent-config/file.ts";
import type { Asked, ModelCatalog } from "../../agent-host/catalog.ts";
import type { McpServers } from "../../agent-mcp/servers.ts";
import type { Services, Session } from "../../agent-session/loop.ts";
import type { SessionStoreFailed } from "../../agent-session/session-store.ts";
import type { SettingOption } from "../../agent-session/configuration/options.ts";
import type { View } from "./view.ts";

/** What a command is run with besides its words. */
export interface CommandContext {
  /** The folder the CLI runs in: `/export` writes under it. */
  readonly folder: string;
  /** The user's configuration folder: `/model` and `/settings` write the user's settings into it. */
  readonly configFolder: string;
  /** What the REPL shows, which `/settings` changes. */
  readonly view: View;
  /** The layers the session's configuration was read from, in order: a layer after the user's folder can set what a command writes into it. */
  readonly layers: ReadonlyArray<LayerSource>;
  /** The session's MCP servers; absent when the session has none. */
  readonly mcp?: McpServers;
}

/** What a line can be completed from: the models that can be asked, the settings to offer for the model being asked, and the session's MCP servers, by name. */
export interface Offered {
  readonly models: ReadonlyArray<string>;
  readonly settings: ReadonlyArray<SettingOption>;
  readonly servers: ReadonlyArray<string>;
}

/** What a command did: text for the REPL to print, nothing to print, or the REPL to end. */
export type Done = { readonly _tag: "Said"; readonly text: string } | { readonly _tag: "Quiet" } | { readonly _tag: "Exit" };

/** What a command did before a model is picked: as in a session, or the model that the session opens with, and what to print first. */
export type DoneWithoutModel = Done | { readonly _tag: "Picked"; readonly target: Asked; readonly text?: string };

/** A command's outcome when it says `text`. */
export const said = (text: string): Done => ({ _tag: "Said", text });

/** What the commands need to run: the terminal for a picker, the files, and the model catalog. In a session, the loop's services too. */
export type Needs = Terminal.Terminal | FileSystem.FileSystem | Path.Path | ModelCatalog;

/**
 * A mistake in a command, said to the user (`invalid.ts`); the user leaving a picker (Ctrl+C); or the
 * session's store failing to record what the command reported.
 */
export type Failure = CliError.UserError | Terminal.QuitError | SessionStoreFailed;

export interface ReplCommand {
  /** The command's name, as it is typed. */
  readonly name: `/${string}`;
  /** Other names the command is typed as. */
  readonly aliases?: ReadonlyArray<`/${string}`>;
  /** What can follow the name, as `/help` shows it: `[name]`. Absent when nothing can. */
  readonly args?: string;
  /** What `/help` says the command does. */
  readonly says: string;
  /** What the line's words (the name first) complete to, from what is offered; nothing when absent. */
  readonly complete?: (words: ReadonlyArray<string>, from: Offered) => ReadonlyArray<string>;
  /** Runs the command in `session` with the words after its name. */
  readonly inSession: (session: Session, words: ReadonlyArray<string>, context: CommandContext) => Effect.Effect<Done, Failure, Needs | Services>;
  /** Runs the command before a model is picked; a command without it is refused until a model is picked. */
  readonly withoutModel?: (words: ReadonlyArray<string>, context: CommandContext) => Effect.Effect<DoneWithoutModel, Failure, Needs>;
}
