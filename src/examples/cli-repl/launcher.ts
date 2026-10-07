/**
 * The agent's command (`bin/labkit.ts`): starts the CLI (`index.ts`) in the folder it is run in,
 * reading that folder's own files only when the folder is trusted (`agent-host/trust.ts`).
 *
 * Bun reads two files from the folder a process starts in, before any of the agent's code runs:
 * - the `.env` files, whose variables can loosen permission, load extensions or start MCP servers
 *   (`LABKIT_SETTINGS`, `LABKIT_MCP_CONFIG`, `LABKIT_PERMISSION_MODE`);
 * - `bunfig.toml`, whose `preload` runs code.
 *
 * So the command runs as two processes:
 * 1. this one, which `bin/labkit.ts` starts with `--no-env-file --config=/dev/null`, so that Bun reads
 *    neither file, and which decides whether the folder is trusted;
 * 2. the CLI, which it starts with the agent's own `bunfig.toml`, and with `--no-env-file` unless the
 *    folder is trusted. A trusted folder's `.env` files are loaded by Bun, by Bun's own rules.
 *
 * A folder's own files are its `.env` files (`.env` and every `.env.*`) and its project settings
 * folder (`.<name>/`). In a folder that is not trusted and has any of them:
 * - at a terminal, unless the CLI is to answer once (`-p`) or only print its help or version, the
 *   command asks whether to trust the folder. Trusting it adds it to the user's trusted folders;
 * - otherwise, the CLI starts without them, and the command says on stderr which it did not read.
 *
 * The trusted folders are listed in the user's configuration folder: `--config-dir`, else its
 * variable, else `~/.config/<name>`, as the CLI finds it (`agent-host/launch.ts`).
 *
 * The command exits with the CLI's exit code, or 128 and the signal's number when a signal ended the
 * CLI. Ctrl+C at a terminal reaches the CLI, which handles it; this process ignores it and waits. A
 * termination signal sent to this process is passed on to the CLI.
 */

import { constants, homedir } from "node:os";
import { join, resolve } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem } from "effect";
import { Prompt } from "effect/cli";
import { type Brand, brandFrom, envPrefixOf } from "../../agent-host/brand.ts";
import { isTrusted, trustFolder } from "../../agent-host/trust.ts";

/** One entry of a folder: its name, and whether it is a folder. */
export interface FolderEntry {
  readonly name: string;
  readonly folder: boolean;
}

/** Returns the names of the folder's own files among `entries`: its `.env` files, and its project settings folder `.<name>/`, written with a trailing `/`. */
export const ownFilesOf = (entries: ReadonlyArray<FolderEntry>, brand: Brand): ReadonlyArray<string> =>
  entries.flatMap((entry) => {
    if (!entry.folder && (entry.name === ".env" || entry.name.startsWith(".env."))) return [entry.name];
    if (entry.folder && entry.name === `.${brand.name}`) return [`${entry.name}/`];
    return [];
  });

/** The arguments with which the CLI answers once or prints its help or version, and so is not to stop for a question. */
const noQuestion: ReadonlyArray<string> = ["-p", "--print", "-h", "--help", "-v", "--version"];

/** Whether to ask about trust: the command runs at a terminal, and `args` start a session that waits for the user. */
export const asksTrust = (args: ReadonlyArray<string>, atTerminal: boolean): boolean => atTerminal && !args.some((arg) => noQuestion.includes(arg));

/**
 * Returns the user's configuration folder as the CLI finds it: `--config-dir <folder>` or
 * `--config-dir=<folder>` in `args`, else the brand's `CONFIG_DIR` variable when it is set and not
 * empty, else undefined (`~/.config/<name>`). Relative values are returned as given; the CLI refuses
 * them.
 */
export const configDirOf = (args: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>>, brand: Brand): string | undefined => {
  const at = args.findIndex((arg) => arg === "--config-dir" || arg.startsWith("--config-dir="));
  const flag = args[at];
  const given = flag === "--config-dir" ? args[at + 1] : flag?.slice("--config-dir=".length);
  const variable = env[`${envPrefixOf(brand)}CONFIG_DIR`];
  return given ?? (variable === undefined || variable === "" ? undefined : variable);
};

/** Returns the command line that starts the CLI: Bun, without the folder's `.env` files unless it is `trusted`, with the agent's own `bunfig`, then the CLI's `entry` and `args`. */
export const cliCommandLine = (start: { readonly bun: string; readonly bunfig: string; readonly entry: string; readonly trusted: boolean; readonly args: ReadonlyArray<string> }): ReadonlyArray<string> => [
  start.bun,
  ...(start.trusted ? [] : ["--no-env-file"]),
  `--config=${start.bunfig}`,
  start.entry,
  ...start.args,
];

/** Returns `names` as one phrase: `a`, `a and b`, or `a, b and c`. */
const listed = (names: ReadonlyArray<string>): string => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** The agent's checkout: the CLI's entry and its `bunfig.toml`. */
const checkout = resolve(import.meta.dir, "..", "..", "..");

/** Asks whether to trust `folder`, whose own files are `own`; true when the user trusts it. Ctrl+C ends the command. */
const askedToTrust = (folder: string, own: ReadonlyArray<string>, brand: Brand) =>
  Prompt.Select({
    message: `Trust ${folder}? Its ${listed(own)} can change what ${brand.name} does.`,
    choices: [
      { title: "Yes, trust this folder", value: true },
      { title: `No, start without reading ${own.length === 1 ? "it" : "them"}`, value: false },
    ],
  });

/** Decides whether the folder the command runs in is trusted, asking when it should, and returns whether it is. */
const trustOfHere = (args: ReadonlyArray<string>, brand: Brand) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const folder = process.cwd();
    const userFolder = configDirOf(args, process.env, brand) ?? join(homedir(), ".config", brand.name);
    if (yield* isTrusted(folder, userFolder)) return true;
    const names = yield* fs.readDirectory(folder);
    const entries = yield* Effect.forEach(names, (name) => Effect.map(Effect.option(fs.stat(join(folder, name))), (info) => ({ name, folder: info._tag === "Some" && info.value.type === "Directory" })));
    const own = ownFilesOf(entries, brand);
    if (own.length === 0) return false;
    if (asksTrust(args, process.stdin.isTTY === true && process.stdout.isTTY === true)) {
      if (!(yield* askedToTrust(folder, own, brand))) return false;
      yield* trustFolder(folder, userFolder);
      return true;
    }
    yield* Console.error(`Not reading ${listed(own)} in this folder, which is not trusted. Start ${brand.name} here at a terminal to trust it.`);
    return false;
  });

/** Starts the CLI with `commandLine`, and returns its exit code once it ends. */
const runCli = (commandLine: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const cli = Bun.spawn([...commandLine], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const passOn = (signal: NodeJS.Signals) => () => cli.kill(signal);
    process.on("SIGINT", () => undefined);
    process.on("SIGTERM", passOn("SIGTERM"));
    process.on("SIGHUP", passOn("SIGHUP"));
    await cli.exited;
    return cli.exitCode ?? 128 + (cli.signalCode === null ? 0 : (constants.signals[cli.signalCode] ?? 0));
  });

/** Runs the command with this process's arguments, as `brand`. */
export const launch = (brand: Brand = brandFrom(process.env)): Promise<never> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const args = process.argv.slice(2);
      const trusted = yield* trustOfHere(args, brand);
      const commandLine = cliCommandLine({ bun: process.execPath, bunfig: join(checkout, "bunfig.toml"), entry: join(checkout, "src", "examples", "cli-repl", "index.ts"), trusted, args });
      return yield* runCli(commandLine);
    }).pipe(
      Effect.catchTags({
        QuitError: () => Effect.succeed(130),
        TrustFileInvalid: (error) => Console.error(`ERROR: The list of trusted folders cannot be read: ${error.message}`).pipe(Effect.as(2)),
        PlatformError: (error) => Console.error(`ERROR: This folder cannot be read: ${error.message}`).pipe(Effect.as(2)),
      }),
      Effect.provide(BunServices.layer),
    ),
  ).then((code) => process.exit(code));
