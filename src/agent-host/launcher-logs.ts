/**
 * The log a launched ACP agent keeps. Its stdout is for the protocol, so its log lines go to a file
 * of its own, `<dir>/acp-<pid>-<launch id>.jsonl`, one JSON object per line: rotated past a size,
 * old launches' files removed at start, secrets redacted. When the file cannot be written, the lines
 * go to stderr: the launcher does not die for its log.
 */

import { appendFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Cause, Console, Effect, FileSystem, Layer, Logger, type LogLevel, Option, Path, References } from "effect";

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
  /** Values replaced by `[redacted]` wherever they occur in a record. */
  readonly secrets: ReadonlyArray<string>;
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

const secretVariable = /API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/** Fields whose value is a credential whatever it is. Anchored: `inputTokens` is not one. */
const secretField =
  /^(?:api[-_]?key|x[-_]api[-_]key|authorization|proxy[-_]authorization|password|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|cookie|set-cookie)$/i;

/** A whole number at least `least`, or undefined for anything else (an empty string is not 0). */
const wholeNumber = (value: string | undefined, least: number): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= least ? number : undefined;
};

/**
 * The options the environment gives: `LABKIT_ACP_LOG_DIR` (`~/.labkit/logs`), `LABKIT_ACP_LOG_LEVEL`
 * (`debug`; one of trace, debug, info, warning, error, fatal), `LABKIT_ACP_LOG_MAX_BYTES` (10 MiB),
 * `LABKIT_ACP_LOG_BACKUPS` (4). A value that does not read falls back to the default. The secrets are
 * the non-empty values of the variables whose names hold API_KEY, TOKEN, SECRET, PASSWORD or
 * CREDENTIAL; the launch id is minted.
 */
export const launcherLogOptionsFrom = (env: Readonly<Record<string, string | undefined>>): LauncherLogOptions => {
  const { LABKIT_ACP_LOG_DIR: dir, LABKIT_ACP_LOG_LEVEL: levelName = "", LABKIT_ACP_LOG_MAX_BYTES: maxBytes, LABKIT_ACP_LOG_BACKUPS: backups } = env;
  return {
    dir: dir ? resolve(dir) : join(homedir(), ".labkit", "logs"),
    // `Object.hasOwn` keeps out names like `constructor`, which every object has.
    level: Object.hasOwn(levelsByName, levelName.toLowerCase()) ? levelsByName[levelName.toLowerCase()]! : "Debug",
    maxBytes: wholeNumber(maxBytes, 1) ?? 10 * 1024 * 1024,
    backups: wholeNumber(backups, 0) ?? 4,
    launchId: crypto.randomUUID(),
    keep: 20,
    secrets: Object.entries(env).flatMap(([name, value]) => (value && secretVariable.test(name) ? [value] : [])),
  };
};

/** Replaces each secret in a text, the longest first so a secret holding another goes whole. */
const redactorOf = (secrets: ReadonlyArray<string>) => {
  const ordered = [...new Set(secrets.filter((secret) => secret !== ""))].sort((a, b) => b.length - a.length);
  return (text: string): string => ordered.reduce((redacted, secret) => redacted.replaceAll(secret, "[redacted]"), text);
};

/** A value as JSON holds it, redacted: errors with their stack and causes, circular references named. */
const plain = (value: unknown, redact: (text: string) => string, seen = new WeakSet<object>()): unknown => {
  if (typeof value === "string") return redact(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
    if (Array.isArray(value)) return value.map((item) => plain(item, redact, seen));
    if (value instanceof Map || value instanceof Set) return [...value].map((item) => plain(item, redact, seen));
    if (!(value instanceof Error) && "toJSON" in value && typeof value.toJSON === "function") return plain(value.toJSON(), redact, seen);
    const out: Record<string, unknown> =
      value instanceof Error
        ? {
            name: redact(value.name),
            message: redact(value.message),
            ...(value.stack === undefined ? {} : { stack: redact(value.stack) }),
            ...(value.cause === undefined ? {} : { cause: plain(value.cause, redact, seen) }),
          }
        : {};
    for (const [key, item] of Object.entries(value)) out[redact(key)] = secretField.test(key) ? "[redacted]" : plain(item, redact, seen);
    return out;
  } finally {
    seen.delete(value);
  }
};

/** The UTF-8 bytes of the code point `point`. */
const utf8Bytes = (point: number): number => (point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4);

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
  let cost = 0;
  let kept = 0;
  let end = 0;
  for (const character of line) {
    const bytes = utf8Bytes(character.codePointAt(0) ?? 0);
    // Embedded in a string, the line's quotes and backslashes are escaped: two bytes each.
    const escaped = character === '"' || character === "\\" ? 2 : bytes;
    if (cost + escaped > budget) break;
    cost += escaped;
    kept += bytes;
    end += character.length;
  }
  return JSON.stringify({ time, level, omittedBytes: size - kept, record: line.slice(0, end) });
};

/** The line a log record is: its time, level, annotations, message and, when there is one, its cause as text. */
const lineOf = (log: Logger.Options<unknown>, redact: (text: string) => string): string => {
  const parts = Array.isArray(log.message) ? log.message : [log.message];
  const time = log.date.toISOString();
  const level = levelNames[log.logLevel];
  const record = {
    time,
    level,
    annotations: plain(log.fiber.getRef(References.CurrentLogAnnotations), redact),
    message: plain(parts.length === 1 ? parts[0] : parts, redact),
    ...(log.cause.reasons.length > 0 ? { cause: redact(Cause.pretty(log.cause)) } : {}),
  };
  return withinLimit(JSON.stringify(record), time, level);
};

/** Shifts `file` to `.1` and each backup one on, the one past `backups` overwritten. */
const rotate = (file: string, backups: number): void => {
  if (backups === 0) {
    rmSync(file, { force: true });
    return;
  }
  for (let index = backups; index >= 1; index--) {
    const from = index === 1 ? file : `${file}.${index - 1}`;
    if (existsSync(from)) renameSync(from, `${file}.${index}`);
  }
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
    const launches = new Map<string, { readonly pid: number; readonly files: Array<string>; time: number }>();
    for (const name of yield* fs.readDirectory(dir)) {
      const found = launchFile.exec(name);
      if (found === null) continue;
      // A file another launcher removed since the listing is no longer there to keep or remove.
      const info = yield* fs.stat(path.join(dir, name)).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      const launch = launches.get(found[1]!) ?? { pid: Number(found[2]), files: [], time: 0 };
      launch.files.push(name);
      launch.time = Math.max(launch.time, Option.match(info.value.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }));
      launches.set(found[1]!, launch);
    }
    const stopped = [...launches.values()].filter((launch) => !isRunning(launch.pid)).sort((a, b) => b.time - a.time);
    for (const launch of stopped.slice(keep)) {
      for (const name of launch.files) yield* fs.remove(path.join(dir, name), { force: true });
    }
  });

/**
 * A logger writing each record at `options.level` and above as a line of
 * `<dir>/acp-<pid>-<launchId>.jsonl`, and that level as the lowest logged. At start it says the
 * file's path on stderr, and removes old launches' files. A write is a synchronous append, so a
 * crash keeps the lines before it. A record that would take the file past `maxBytes` rotates it
 * first. The first failure to write is said on stderr; that line and every one after go to stderr.
 */
export const LauncherLogs = (options: LauncherLogOptions): Layer.Layer<never, never, FileSystem.FileSystem | Path.Path> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const redact = redactorOf(options.secrets);
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
      let failed = made === undefined;
      let size = made ?? 0;
      const logger = Logger.make((log) => {
        const line = lineOf(log, redact);
        const console = log.fiber.getRef(Console.Console);
        if (!failed) {
          try {
            const bytes = Buffer.byteLength(line) + 1;
            if (size > 0 && size + bytes > options.maxBytes) {
              rotate(file, options.backups);
              size = 0;
            }
            appendFileSync(file, `${line}\n`, { mode: 0o600 });
            size += bytes;
            return;
          } catch (error) {
            failed = true;
            console.error(cannotWrite(error));
          }
        }
        console.error(line);
      });
      return Layer.mergeAll(Logger.layer([logger]), Layer.succeed(References.MinimumLogLevel, options.level));
    }),
  );
