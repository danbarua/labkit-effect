/**
 * The ACP agent as an editor launches it: `bun src/agent-acp/main.ts [flags]`, the protocol on stdin
 * and stdout and nothing else on stdout. Its log is a file (`launcher-logs.ts`) whose path it says
 * once on stderr; it exits 0 when stdin closes.
 *
 * It runs as the brand `launch` is given, else the one the environment names (`LABKIT_BRAND`), else
 * labkit (`agent-host/brand.ts`). Its options are those both hosts take (`agent-host/launch.ts`:
 * `--model`, `--permission-mode`, `--strict-tool-input`, `--max-turns`, `--max-budget-usd`,
 * `--settings`, `--setting-sources`, `--mcp-config`, `--strict-mcp-config`) and its own:
 * `--sessions-dir` (where sessions are kept, default `~/.<brand>/sessions`), `--local-tools` (the
 * stopgap tools on the local disk) and `--retries` (how many times a turn with thinking and no answer
 * is asked again for it; 1). A flag not given is read from its variable: the brand's prefix, `ACP_`,
 * then the flag's name in capitals (`LABKIT_ACP_MODEL`, `LABKIT_ACP_SESSIONS_DIR`). The log's
 * variables are `<PREFIX>ACP_LOG_*` (`launcher-logs.ts`); the providers' keys are `ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY` and `XAI_API_KEY`.
 *
 * Before it serves, it loads what of each session's configuration no session's folder changes: the
 * host's defaults, the user's file, `--settings`, `--mcp-config` and the flags. An option, or
 * a configuration, that cannot be used ends it at once, said on stderr, with exit code 1. What the
 * command line prints (help, an option's error) goes to stderr.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BunRuntime, BunServices, BunStdio } from "@effect/platform-bun";
import { Console, ConfigProvider, Effect, Layer } from "effect";
import { Command } from "effect/cli";
import * as Agent from "effective-acp/agent";
import { type Brand, brandFrom, folderOf } from "../agent-host/brand.ts";
import { KeyedAndLocalCatalog } from "../agent-host/catalog.ts";
import { LauncherLogs, launcherLogOptionsFrom } from "../agent-host/launcher-logs.ts";
import { intFlag, launchConfiguration, launchFlags, launchVariables, textFlag, toggleFlag } from "../agent-host/launch.ts";
import { acpDefaults, type HostOptions, makeHost } from "./host.ts";
import { logKeys } from "./log-keys.ts";

/** The launcher's options: those both hosts take, and its own. */
export const launcherFlags = {
  ...launchFlags,
  sessionsDir: textFlag("sessions-dir", "Where sessions are kept (~/.<brand>/sessions when not given)"),
  localTools: toggleFlag("local-tools", "The tools on the local disk instead of through the editor: a stopgap"),
  retries: intFlag("retries", "How many times a turn with thinking and no answer is asked again for it; 0 never (1 when not given)"),
};

export type LauncherOptions = Command.Command.Config.Infer<typeof launcherFlags>;

/** Where sessions are kept: the folder given, else `~/.<brand>/sessions`. */
export const sessionsDirectoryOf = (given: string | undefined, brand: Brand): string => (given ? resolve(given) : join(homedir(), folderOf(brand), "sessions"));

/** The host's options, from the launcher's. */
export const hostOptionsOf = (options: LauncherOptions, brand: Brand, home?: string): HostOptions => ({
  directory: sessionsDirectoryOf(options.sessionsDir, brand),
  world: options.localTools ? "local" : "editor",
  model: options.model,
  configFlags: options,
  retries: options.retries,
  strictToolInput: options.strictToolInput,
  brand,
  ...(home === undefined ? {} : { home }),
});

/** What of each session's configuration no session's folder changes, loaded once: it fails when it cannot be used. */
export const launchChecked = (options: LauncherOptions, brand: Brand, home?: string) =>
  launchConfiguration(undefined, acpDefaults(options), options, { name: brand.name, ...(home === undefined ? {} : { home }) });

/** What the command line prints, on stderr: stdout is the protocol's. */
const toStderr: Console.Console = (() => {
  const error = (...args: ReadonlyArray<unknown>) => globalThis.console.error(...args);
  return { ...globalThis.console, log: error, info: error, debug: error, table: error };
})();

/**
 * The agent on this process's stdin and stdout, with `args` and `env`, as `brand` (the one `env`
 * names, else the default, unless a program gives one). It returns when stdin closes.
 */
export const launch = (args: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>>, brand: Brand = brandFrom(env)) => {
  const launcher = Command.make(`${brand.name}-acp`, launcherFlags, (options) =>
    launchChecked(options, brand).pipe(
      Effect.tapError((error) =>
        Effect.logError(logKeys.launch.refused, { cause: "the configuration cannot be used", problem: error.message }).pipe(
          Effect.andThen(Console.error(`The configuration cannot be used: ${error.message}`)),
        ),
      ),
      Effect.andThen(
        Agent.runStdio({
          info: { name: brand.name, version: brand.version },
          implementations: [makeHost(hostOptionsOf(options, brand))],
        }),
      ),
    ),
  ).pipe(Command.withDescription("The agent over ACP, on stdin and stdout, as an editor launches it."));
  return Command.runWith(launcher, { version: brand.version })(args).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, launchVariables(brand, ["ACP"], env)),
    Effect.provideService(Console.Console, toStderr),
    Effect.provide(Layer.mergeAll(KeyedAndLocalCatalog, LauncherLogs(launcherLogOptionsFrom(env, brand)).pipe(Layer.provideMerge(BunServices.layer)), BunStdio.layer)),
  );
};

// What ended a launch is said on stderr (by `launch`, or the command line): the runtime's report would go to stdout.
if (import.meta.main) BunRuntime.runMain(launch(process.argv.slice(2), process.env), { disableErrorReporting: true });
