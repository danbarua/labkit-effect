/**
 * The log of a launched ACP agent. Its stdout carries the protocol, so its log lines go to a file of
 * its own, `<dir>/acp-<pid>-<launch id>.jsonl`, one JSON object per line. The file is rotated past a
 * size, old launches' files are removed at start, and secrets are redacted. When the file cannot be
 * written, the lines go to stderr, so the launcher does not stop because of its log.
 */

import { type Brand, brandFrom, envPrefixOf, folderOf } from "./brand.ts";
import { redactedValue, redactorOf, type Secrets, sayingTooShort, secretsOf } from "./redaction.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Array as Arr, Cause, Console, Effect, FileSystem, Layer, Logger, type LogLevel, Option, Order, Path, References } from "effect";
import { logFile } from "./log-file.ts";

export interface LauncherLogOptions {
  /** The folder for the launch's file, created when missing. */
  readonly dir: string;
  /** The lowest level written. */
  readonly level: LogLevel.Severity;
  /** The file size, in bytes, at which the file is rotated. */
  readonly maxBytes: number;
  /** How many rotated files a launch keeps: `.jsonl.1` (the newest) to `.jsonl.<backups>`. */
  readonly backups: number;
  /** This launch's id, in the file's name after the pid. */
  readonly launchId: string;
  /** How many stopped launches' files are kept at start, the newest by modification time. */
  readonly keep: number;
  /** The secrets to redact (`redaction.ts`); those too short to search for are reported at start. */
  readonly secrets: Secrets;
}

/** A record's line is cut past this many UTF-8 bytes. */
export const recordLimit = 256 * 1024;

const levelsByName: Record<string, LogLevel.Severity> = {
  trace: "Trace",
  debug: "Debug",
  info: "Info",
  warning: "Warn",
  error: "Error",
  fatal: "Fatal",
};

const levelNames: Record<LogLevel.LogLevel, string> = {
  All: "all",
  Trace: "trace",
  Debug: "debug",
  Info: "info",
  Warn: "warning",
  Error: "error",
  Fatal: "fatal",
  None: "none",
};


/** Parses a whole number of at least `least`; returns undefined for anything else (an empty string is not 0). */
const wholeNumber = (value: string | undefined, least: number): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= least ? number : undefined;
};

/**
 * Returns the options from the environment, each variable after the brand's prefix (`LABKIT_` for
 * labkit). Defaults are in parentheses:
 * - `ACP_LOG_DIR` (`~/.<brand>/logs`);
 * - `ACP_LOG_LEVEL` (`debug`; one of trace, debug, info, warning, error, fatal);
 * - `ACP_LOG_MAX_BYTES` (10 MiB);
 * - `ACP_LOG_BACKUPS` (4).
 *
 * A value that does not parse takes the default. The secrets come from the environment
 * (`redaction.ts` `secretsOf`); the launch id is generated.
 */
export const launcherLogOptionsFrom = (env: Readonly<Record<string, string | undefined>>, brand: Brand = brandFrom(env)): LauncherLogOptions => {
  const prefix = `${envPrefixOf(brand)}ACP_LOG_`;
  const [dir, levelName = "", maxBytes, backups] = [env[`${prefix}DIR`], env[`${prefix}LEVEL`], env[`${prefix}MAX_BYTES`], env[`${prefix}BACKUPS`]];
  return {
    dir: dir ? resolve(dir) : join(homedir(), folderOf(brand), "logs"),
    // `Object.hasOwn` keeps out names like `constructor`, which every object has.
    level: Object.hasOwn(levelsByName, levelName.toLowerCase()) ? levelsByName[levelName.toLowerCase()]! : "Debug",
    maxBytes: wholeNumber(maxBytes, 1) ?? 10 * 1024 * 1024,
    backups: wholeNumber(backups, 0) ?? 4,
    launchId: crypto.randomUUID(),
    keep: 20,
    secrets: secretsOf(env),
  };
};

/** Returns the number of UTF-8 bytes that the code point `point` takes. */
const utf8Bytes = (point: number): number => {
  if (point < 0x80) return 1;
  if (point < 0x800) return 2;
  if (point < 0x10000) return 3;
  return 4;
};

/** Returns the number of bytes that `character` takes inside a JSON string: two for an escaped quote or backslash, its UTF-8 bytes for any other character. */
const escapedBytes = (character: string): number => (character === '"' || character === "\\" ? 2 : utf8Bytes(character.codePointAt(0) ?? 0));

/**
 * Returns `line` unchanged when it fits in `recordLimit`; otherwise a record that fits, holding its
 * time and level, the line's start as text (`record`), and the number of bytes omitted
 * (`omittedBytes`).
 */
const withinLimit = (line: string, time: string, level: string): string => {
  const size = Buffer.byteLength(line);
  if (size <= recordLimit) return line;
  // `omittedBytes` is at most `size`, so the frame written with `size` is as long as the final one can be.
  const frame = Buffer.byteLength(JSON.stringify({ time, level, omittedBytes: size, record: "" }));
  const budget = recordLimit - frame;
  const characters = Array.from(line);
  // The escaped size of the line's start after each character; the line is kept up to the first character that exceeds the budget.
  const [, costs] = Arr.mapAccum(characters, 0, (cost, character) => [cost + escapedBytes(character), cost + escapedBytes(character)] as const);
  const over = costs.findIndex((cost) => cost > budget);
  const kept = characters.slice(0, over === -1 ? characters.length : over).join("");
  return JSON.stringify({ time, level, omittedBytes: size - Buffer.byteLength(kept), record: kept });
};

/** Returns a log record's line: its time, level, annotations, message and, when there is one, its cause as text. */
const lineOf = (log: Logger.Options<unknown>, redact: (text: string) => string): string => {
  const parts = Array.isArray(log.message) ? log.message : [log.message];
  const time = log.date.toISOString();
  const level = levelNames[log.logLevel];
  const record = {
    time,
    level,
    annotations: redactedValue(log.fiber.getRef(References.CurrentLogAnnotations), redact),
    message: redactedValue(parts.length === 1 ? parts[0] : parts, redact),
    ...(log.cause.reasons.length > 0 ? { cause: redact(Cause.pretty(log.cause)) } : {}),
  };
  return withinLimit(JSON.stringify(record), time, level);
};

/** Whether the process `pid` is running. Only "no such process" means it is not: another user's process is still running. */
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
};

/** A launch's file or one of its backups: `acp-<pid>-<launch id>.jsonl[.<n>]`. */
const launchFile = /^(acp-(\d+)-.+?\.jsonl)(?:\.\d+)?$/;

/** Removes the files of the stopped launches in `dir` beyond the newest `keep`. A running launch's files stay and do not count. */
const removeOldLaunches = (dir: string, keep: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const named = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const found = launchFile.exec(name);
      return found === null ? [] : [{ name, launch: found[1] ?? name, pid: Number(found[2]) }];
    });
    // A file that another launcher removed after the listing is skipped.
    const dated = yield* Effect.forEach(named, (file) =>
      fs.stat(path.join(dir, file.name)).pipe(
        Effect.option,
        Effect.map(Option.map((info) => ({ ...file, time: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }) }))),
      ),
    );
    // Each launch: its pid, its files, and the time the newest of them was written.
    const launches = Object.values(Arr.groupBy(dated.flatMap(Option.toArray), (file) => file.launch)).map((files) => ({
      pid: files[0].pid,
      files: files.map((file) => file.name),
      time: Math.max(...files.map((file) => file.time)),
    }));
    const stopped = Arr.sort(
      launches.filter((launch) => !isRunning(launch.pid)),
      Order.mapInput(Order.flip(Order.Number), (launch: (typeof launches)[number]) => launch.time),
    );
    yield* Effect.forEach(
      stopped.slice(keep).flatMap((launch) => launch.files),
      (name) => fs.remove(path.join(dir, name), { force: true }),
      { discard: true },
    );
  });

/**
 * A logger that writes each record at `options.level` and above as a line of
 * `<dir>/acp-<pid>-<launchId>.jsonl`, and sets that level as the minimum logged.
 * - At start it writes the file's path to stderr, removes old launches' files, and logs a warning
 *   naming the secrets too short to search for (`redaction.ts`).
 * - A write is a synchronous append, so a crash keeps the lines written before it.
 * - A record that would take the file past `maxBytes` rotates the file first.
 * - The first failure to write is reported on stderr; that line and every later one go to stderr.
 */
export const LauncherLogs = (options: LauncherLogOptions): Layer.Layer<never, never, FileSystem.FileSystem | Path.Path> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const redact = redactorOf(options.secrets.values);
      const file = path.join(options.dir, `acp-${process.pid}-${options.launchId}.jsonl`);
      const cannotWrite = (error: unknown) => redact(`ACP log: cannot write ${file} (${String(error)}); logging to stderr`);
      yield* Console.error(`ACP log: ${file}`);
      const made = yield* fs.makeDirectory(options.dir, { recursive: true, mode: 0o700 }).pipe(
        Effect.andThen(
          removeOldLaunches(options.dir, options.keep).pipe(
            Effect.catch((error) => Console.error(redact(`ACP log: could not remove old launches' logs in ${options.dir} (${String(error)})`))),
          ),
        ),
        Effect.andThen(fs.writeFileString(file, "", { flag: "a", mode: 0o600 })),
        Effect.andThen(fs.stat(file)),
        Effect.map((info) => Number(info.size)),
        Effect.catch((error) => Console.error(cannotWrite(error)).pipe(Effect.as(undefined))),
      );
      const written = logFile(file, made, options);
      const logger = Logger.make((log) => {
        const line = lineOf(log, redact);
        const console = log.fiber.getRef(Console.Console);
        const appended = written.append(line);
        switch (appended._tag) {
          case "Written":
            return;
          // The first failure is reported once, and this line and every later one go to stderr.
          case "FirstFailure":
            console.error(cannotWrite(appended.error));
            console.error(line);
            return;
          case "FailedEarlier":
            console.error(line);
            return;
          default:
            return appended satisfies never;
        }
      });
      const logs = Layer.mergeAll(Logger.layer([logger]), Layer.succeed(References.MinimumLogLevel, options.level));
      return sayingTooShort(options.secrets, logs);
    }),
  );
