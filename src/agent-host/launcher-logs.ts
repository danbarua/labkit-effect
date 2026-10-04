/**
 * The log a launched ACP agent keeps. Its stdout is for the protocol, so its log lines go to a file
 * of its own, `<dir>/acp-<pid>-<launch id>.jsonl`, one JSON object per line: rotated past a size,
 * old launches' files removed at start, secrets redacted. When the file cannot be written, the lines
 * go to stderr: the launcher does not die for its log.
 */

import { type Brand, brandFrom, envPrefixOf, folderOf } from "./brand.ts";
import { redactedValue, redactorOf, type Secrets, sayingTooShort, secretsOf } from "./redaction.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Array as Arr, Cause, Console, Effect, FileSystem, Layer, Logger, type LogLevel, Option, Order, Path, References } from "effect";
import { logFile } from "./log-file.ts";

export interface LauncherLogOptions {
  /** The folder the launch's file goes in, made when missing. */
  readonly dir: string;
  /** The lowest level written. */
  readonly level: LogLevel.Severity;
  /** The size a file is rotated at, in bytes. */
  readonly maxBytes: number;
  /** How many rotated files a launch keeps: `.jsonl.1` (the newest) to `.jsonl.<backups>`. */
  readonly backups: number;
  /** This launch's id, in the file's name after the pid. */
  readonly launchId: string;
  /** How many stopped launches' files are kept at start, the newest by modification time. */
  readonly keep: number;
  /** What a record leaves out (`redaction.ts`); those not looked for are said at start. */
  readonly secrets: Secrets;
}

/** A record's line is cut past this many bytes of UTF-8. */
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


/** A whole number at least `least`, or undefined for anything else (an empty string is not 0). */
const wholeNumber = (value: string | undefined, least: number): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= least ? number : undefined;
};

/**
 * The options the environment gives, the brand's prefix before each (`LABKIT_` for labkit's):
 * `ACP_LOG_DIR` (`~/.<brand>/logs`), `ACP_LOG_LEVEL` (`debug`; one of trace, debug, info, warning,
 * error, fatal), `ACP_LOG_MAX_BYTES` (10 MiB), `ACP_LOG_BACKUPS` (4). A value that does not read falls
 * back to the default. The secrets are the environment's (`redaction.ts` `secretsOf`); the launch id
 * is minted.
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

/** How many bytes the code point `point` takes in UTF-8. */
const utf8Bytes = (point: number): number => {
  if (point < 0x80) return 1;
  if (point < 0x800) return 2;
  if (point < 0x10000) return 3;
  return 4;
};

/** How many bytes `character` takes inside a JSON string: a quote or a backslash is escaped, two bytes; any other character its UTF-8 bytes. */
const escapedBytes = (character: string): number => (character === '"' || character === "\\" ? 2 : utf8Bytes(character.codePointAt(0) ?? 0));

/**
 * `line` as it is when it fits in `recordLimit`; else a record of its time and level, the line's
 * start as text (`record`) and the bytes of it left out (`omittedBytes`), which fits.
 */
const withinLimit = (line: string, time: string, level: string): string => {
  const size = Buffer.byteLength(line);
  if (size <= recordLimit) return line;
  // `omittedBytes` is at most `size`, so the frame written with `size` is as long as the final one can be.
  const frame = Buffer.byteLength(JSON.stringify({ time, level, omittedBytes: size, record: "" }));
  const budget = recordLimit - frame;
  const characters = Array.from(line);
  // The bytes the line's start takes, escaped, after each character; the line is kept up to the first that exceeds the budget.
  const [, costs] = Arr.mapAccum(characters, 0, (cost, character) => [cost + escapedBytes(character), cost + escapedBytes(character)] as const);
  const over = costs.findIndex((cost) => cost > budget);
  const kept = characters.slice(0, over === -1 ? characters.length : over).join("");
  return JSON.stringify({ time, level, omittedBytes: size - Buffer.byteLength(kept), record: kept });
};

/** The line a log record is: its time, level, annotations, message and, when there is one, its cause as text. */
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

/** Whether a process `pid` runs. Only "no such process" says it does not: one of another user's runs. */
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

/** Removes the files of the stopped launches in `dir` past the newest `keep`; a running launch's stay and do not count. */
const removeOldLaunches = (dir: string, keep: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const named = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const found = launchFile.exec(name);
      return found === null ? [] : [{ name, launch: found[1] ?? name, pid: Number(found[2]) }];
    });
    // A file another launcher removed since the listing is no longer there to keep or remove.
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
 * A logger writing each record at `options.level` and above as a line of
 * `<dir>/acp-<pid>-<launchId>.jsonl`, and that level as the lowest logged. At start it says the
 * file's path on stderr, removes old launches' files, and logs the secrets it does not look for
 * (`redaction.ts`). A write is a synchronous append, so a
 * crash keeps the lines before it. A record that would take the file past `maxBytes` rotates it
 * first. The first failure to write is said on stderr; that line and every one after go to stderr.
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
          // The first failure is said once, and this line and every line after it go to stderr.
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
