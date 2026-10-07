/**
 * The lowest level a program logs, read from its environment. Every entry point reads
 * `<PREFIX>LOG_LEVEL` (`LABKIT_LOG_LEVEL` for labkit; the prefix is the brand's, `brand.ts`), default
 * `info`. The ACP launcher reads `<PREFIX>ACP_LOG_LEVEL` before it, and its default is `debug`
 * (`launcher-logs.ts`). A level is named as the CLI's `--log-level` names it (effect/cli's
 * `GlobalFlag.LogLevel`): all, trace, debug, info, warn or warning, error, fatal, none; in any case.
 *
 * The level is the program's `References.MinimumLogLevel`, so `LogLevel.isEnabled(level)` is true
 * exactly when a line at that level is logged. A variable whose value names no level is passed over,
 * and once the program's loggers are installed a warning names the variable, its value and the level
 * used.
 */

import { Effect, Layer, type LogLevel, References } from "effect";
import { type Brand, brandFrom, envPrefixOf } from "./brand.ts";
import { logKeys } from "./log-keys.ts";

/** The level each name names: the names that effect/cli's `--log-level` takes, so the flag and the variable take the same values. */
const levelsByName: Record<string, LogLevel.LogLevel> = {
  all: "All",
  trace: "Trace",
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  warning: "Warn",
  error: "Error",
  fatal: "Fatal",
  none: "None",
};

/** Each level's name as log lines write it. */
export const levelNames: Record<LogLevel.LogLevel, string> = {
  All: "all",
  Trace: "trace",
  Debug: "debug",
  Info: "info",
  Warn: "warning",
  Error: "error",
  Fatal: "fatal",
  None: "none",
};

/** Returns the level that `name` names, in any case; undefined for anything else. */
export const levelNamed = (name: string): LogLevel.LogLevel | undefined => {
  const lower = name.toLowerCase();
  // `Object.hasOwn` keeps out names like `constructor`, which every object has.
  return Object.hasOwn(levelsByName, lower) ? levelsByName[lower] : undefined;
};

/** A variable set to a value that names no level. */
export interface InvalidLevel {
  readonly variable: string;
  readonly value: string;
}

/** The level a program logs at, and the variables passed over on the way to it. */
export interface LevelSetting {
  readonly level: LogLevel.LogLevel;
  /** The variables read before the level was found that are set to a value naming no level, in the order read. */
  readonly invalid: ReadonlyArray<InvalidLevel>;
}

/**
 * Returns the level of the first of `variables` in `env` that names one, else `fallback`. A variable
 * that is unset or empty is not given; one set to a value that names no level is listed as invalid.
 */
export const levelFrom = (env: Readonly<Record<string, string | undefined>>, variables: ReadonlyArray<string>, fallback: LogLevel.LogLevel): LevelSetting => {
  const [variable, ...rest] = variables;
  if (variable === undefined) return { level: fallback, invalid: [] };
  const value = env[variable];
  if (value === undefined || value === "") return levelFrom(env, rest, fallback);
  const level = levelNamed(value);
  if (level !== undefined) return { level, invalid: [] };
  const after = levelFrom(env, rest, fallback);
  return { ...after, invalid: [{ variable, value }, ...after.invalid] };
};

/** Returns the variable that names the level of `brand`'s programs: the brand's prefix, then `LOG_LEVEL`. */
export const logLevelVariableOf = (brand: Brand): string => `${envPrefixOf(brand)}LOG_LEVEL`;

/** Returns the level that `env` gives the programs of `brand` (by default, the brand `env` names): `<PREFIX>LOG_LEVEL`, else info. */
export const logLevelOf = (env: Readonly<Record<string, string | undefined>>, brand: Brand = brandFrom(env)): LevelSetting =>
  levelFrom(env, [logLevelVariableOf(brand)], "Info");

/** Logs a warning for each of `invalid`, naming the variable, its value and the level in force (`References.MinimumLogLevel`). */
export const warnInvalidLevels = (invalid: ReadonlyArray<InvalidLevel>): Effect.Effect<void> =>
  invalid.length === 0
    ? Effect.void
    : Effect.gen(function* () {
        const level = levelNames[yield* References.MinimumLogLevel];
        yield* Effect.forEach(invalid, ({ variable, value }) => Effect.logWarning(logKeys.logs.levelInvalid, { variable, value, level }), { discard: true });
      });

/** Returns `logs`, which first log a warning for each of `invalid` (`warnInvalidLevels`). */
export const withInvalidLevelWarning = <E, R>(invalid: ReadonlyArray<InvalidLevel>, logs: Layer.Layer<never, E, R>): Layer.Layer<never, E, R> =>
  invalid.length === 0 ? logs : Layer.merge(logs, Layer.effectDiscard(warnInvalidLevels(invalid)).pipe(Layer.provide(logs)));

/** Returns `logs` with `setting.level` as the minimum level logged, which first log a warning for each variable that named no level. */
export const withLogLevel = <E, R>(setting: LevelSetting, logs: Layer.Layer<never, E, R>): Layer.Layer<never, E, R> =>
  withInvalidLevelWarning(setting.invalid, Layer.merge(logs, Layer.succeed(References.MinimumLogLevel, setting.level)));
