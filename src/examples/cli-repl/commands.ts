/**
 * The REPL's commands: lines that start with `/` and are not sent to the model. Each command is in
 * its own file in `commands/`, written against `command.ts`, and listed in `commands` here, in `/help`
 * order. `/help` and `/exit`, which concern the REPL itself, are defined here.
 *
 * `completions` completes a line that starts with `/`: first a command name, then that command's
 * arguments.
 */

import { Effect } from "effect";
import type { McpServers } from "../../agent-mcp/servers.ts";
import type { Session } from "../../agent-session/loop.ts";
import { optionsOf } from "../../agent-session/configuration/options.ts";
import { type CommandContext, type Done, type DoneWithoutModel, type Offered, type ReplCommand, said } from "./command.ts";
import { addDir } from "./commands/add-dir.ts";
import { effort } from "./commands/effort.ts";
import { exportCommand } from "./commands/export.ts";
import { mcp } from "./commands/mcp.ts";
import { model } from "./commands/model.ts";
import { settings } from "./commands/settings.ts";
import { switchCommand } from "./commands/switch.ts";
import { tools } from "./commands/tools.ts";
import { invalid } from "./invalid.ts";
import { pickable } from "./picking.ts";

/** The text of `/help`: each command, its arguments, and what it does. */
export const help = (): string => {
  const usages = commands.map((each) => [each.args === undefined ? each.name : `${each.name} ${each.args}`, each.says] as const);
  const width = Math.max(...usages.map(([usage]) => usage.length)) + 2;
  return [...usages.map(([usage, says]) => `${usage.padEnd(width)}${says}`), "Anything else is sent to the model."].join("\n");
};

const helpCommand: ReplCommand = {
  name: "/help",
  says: "Show these commands",
  inSession: () => Effect.succeed(said(help())),
  withoutModel: () => Effect.succeed(said(help())),
};

const exit: ReplCommand = {
  name: "/exit",
  aliases: ["/quit"],
  says: "Quit (also /quit)",
  inSession: () => Effect.succeed({ _tag: "Exit" } as const),
  withoutModel: () => Effect.succeed({ _tag: "Exit" } as const),
};

/** The REPL's commands, in `/help` order. */
export const commands: ReadonlyArray<ReplCommand> = [model, switchCommand, effort, settings, tools, addDir, exportCommand, mcp, helpCommand, exit];

/** The error for a line that starts with `/` but names no command. */
export const noCommand = (line: string) => invalid(`Unknown command: ${line.trim().split(/\s+/)[0] ?? line}.`, "Type /help to list the commands.");

/** Returns the command `line` starts with and the words after it; undefined when it names none. */
const commandIn = (line: string) => {
  const [name = "", ...words] = line.trim().split(/\s+/);
  const found = commands.find((each) => each.name === name || each.aliases?.some((alias) => alias === name) === true);
  return found === undefined ? undefined : { command: found, words };
};

/** Runs the command `line` names in `session`; fails when it names none. */
export const runInSession = (session: Session, line: string, context: CommandContext) =>
  Effect.gen(function* () {
    const named = commandIn(line);
    if (named === undefined) return yield* noCommand(line);
    const done: Done = yield* named.command.inSession(session, named.words, context);
    return done;
  });

/**
 * Runs the command `line` names before a model is picked. A command that needs a model is refused
 * with a hint to pick one; a line that names no command is refused too.
 */
export const runWithoutModel = (line: string, context: CommandContext) =>
  Effect.gen(function* () {
    const named = commandIn(line);
    if (named === undefined) return yield* noCommand(line);
    if (named.command.withoutModel === undefined) return yield* invalid(`${named.command.name} needs a model.`, "Pick one with /model.");
    const done: DoneWithoutModel = yield* named.command.withoutModel(named.words, context);
    return done;
  });

export const offered = (session: Session, servers?: McpServers) =>
  Effect.gen(function* () {
    const result: Offered = { models: (yield* pickable).map((each) => each.value), settings: (yield* optionsOf(yield* session.facts)).offered, servers: servers?.names ?? [] };
    return result;
  });

/** What completion draws on before a model is picked: the usable models only. */
export const offeredWithoutModel = Effect.map(pickable, (models): Offered => ({ models: models.map((each) => each.value), settings: [], servers: [] }));

/** The command names as completed: with a trailing space for a command that takes arguments. */
const typedAs = commands.flatMap((each) => [each.args === undefined ? each.name : `${each.name} `, ...(each.aliases ?? [])]);

/**
 * Returns the completions of `text` when it starts with `/`: its last word completed to a command
 * name, or, after a command name, to that command's completions.
 */
export const completions =
  (from: Offered) =>
  (text: string): ReadonlyArray<string> => {
    if (!text.startsWith("/") || text.includes("\n")) return [];
    const words = text.split(" ");
    const last = words.at(-1) ?? "";
    const before = text.slice(0, text.length - last.length);
    const candidates = words.length === 1 ? typedAs : (commands.find((each) => each.name === words[0])?.complete?.(words, from) ?? []);
    return candidates.flatMap((each) => (each.startsWith(last) ? [before + each] : []));
  };
