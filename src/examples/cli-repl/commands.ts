/**
 * The REPL's own commands: lines that start with `/` and do not go to the model. Each command is in
 * its own file in `commands/`, written against `command.ts`, and listed in `commands` here, in the
 * order `/help` shows them. `/help` and `/exit`, which are about the REPL itself, are here.
 *
 * `completions` gives the prompt what a line that starts with `/` could become: a command's name,
 * then what that command completes its words to.
 */

import { Effect } from "effect";
import type { McpServers } from "../../agent-mcp/servers.ts";
import type { Session } from "../../agent-session/loop.ts";
import { optionsOf } from "../../agent-session/configuration/options.ts";
import { type CommandContext, type Done, type DoneWithoutModel, type Offered, type ReplCommand, said } from "./command.ts";
import { effort } from "./commands/effort.ts";
import { exportCommand } from "./commands/export.ts";
import { mcp } from "./commands/mcp.ts";
import { model } from "./commands/model.ts";
import { settings } from "./commands/settings.ts";
import { switchCommand } from "./commands/switch.ts";
import { tools } from "./commands/tools.ts";
import { invalid } from "./invalid.ts";
import { pickable } from "./picking.ts";

/** The text of `/help`: each command, what can follow it, and what it does. */
export const help = (): string => {
  const usages = commands.map((each) => [each.args === undefined ? each.name : `${each.name} ${each.args}`, each.says] as const);
  const width = Math.max(...usages.map(([usage]) => usage.length)) + 2;
  return [...usages.map(([usage, says]) => `${usage.padEnd(width)}${says}`), "Anything else goes to the model."].join("\n");
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

/** The REPL's commands, in the order `/help` shows them. */
export const commands: ReadonlyArray<ReplCommand> = [model, switchCommand, effort, settings, tools, exportCommand, mcp, helpCommand, exit];

/** What the REPL says of a line that starts with `/` and names none of its commands. */
export const noCommand = (line: string) => invalid(`No command ${line.trim().split(/\s+/)[0] ?? line}.`, "/help lists them.");

/** The command that `line` starts with, and the words after its name; undefined when `line` names none. */
const commandIn = (line: string) => {
  const [name = "", ...words] = line.trim().split(/\s+/);
  const found = commands.find((each) => each.name === name || each.aliases?.some((alias) => alias === name) === true);
  return found === undefined ? undefined : { command: found, words };
};

/** Runs the command that `line` names in `session`; fails saying so when `line` names none. */
export const runInSession = (session: Session, line: string, context: CommandContext) =>
  Effect.gen(function* () {
    const named = commandIn(line);
    if (named === undefined) return yield* noCommand(line);
    const done: Done = yield* named.command.inSession(session, named.words, context);
    return done;
  });

/**
 * Runs the command that `line` names before a model is picked. A command that does not run without
 * a model is refused, saying to pick one; so is a line that names no command.
 */
export const runWithoutModel = (line: string, context: CommandContext) =>
  Effect.gen(function* () {
    const named = commandIn(line);
    if (named === undefined) return yield* noCommand(line);
    if (named.command.withoutModel === undefined) return yield* invalid(`${named.command.name} works once a model is picked.`, "Pick one with /model.");
    const done: DoneWithoutModel = yield* named.command.withoutModel(named.words, context);
    return done;
  });

export const offered = (session: Session, servers?: McpServers) =>
  Effect.gen(function* () {
    const result: Offered = { models: (yield* pickable).map((each) => each.value), settings: (yield* optionsOf(yield* session.facts)).offered, servers: servers?.names ?? [] };
    return result;
  });

/** What a line can be completed from before a model is picked: the models that can be asked; no settings, and no servers. */
export const offeredWithoutModel = Effect.map(pickable, (models): Offered => ({ models: models.map((each) => each.value), settings: [], servers: [] }));

/** The commands' names as they are typed: with a space after a name that words can follow. */
const typedAs = commands.flatMap((each) => [each.args === undefined ? each.name : `${each.name} `, ...(each.aliases ?? [])]);

/**
 * The lines that `text` could become, when it starts with `/`: its last word completed to a
 * command's name, or after a command's name, to what that command completes it to.
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
