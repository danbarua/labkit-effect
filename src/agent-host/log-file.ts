/**
 * A log file written by synchronous appends. Effect calls a logger's function synchronously, and a
 * synchronous append keeps every line written before a crash. The file's size, and whether writing
 * has failed, are therefore mutable state here. This file is glue to Node's synchronous file system
 * API, and `oxlint.config.ts` lists it as an imperative boundary.
 */

import { appendFileSync, existsSync, renameSync, rmSync } from "node:fs";

/**
 * Shifts `file` to `<file>.1` and each backup `<file>.<n>` to `<file>.<n+1>`, overwriting the backup
 * past `backups`. With `backups` 0, deletes `file`.
 */
export const rotate = (file: string, backups: number): void => {
  if (backups === 0) {
    rmSync(file, { force: true });
    return;
  }
  for (let index = backups; index >= 1; index -= 1) {
    const from = index === 1 ? file : `${file}.${index - 1}`;
    if (existsSync(from)) renameSync(from, `${file}.${index}`);
  }
};

/** What an append did: wrote the line; failed for the first time, with the error; or did not write, as an earlier append failed. */
export type Appended = { readonly _tag: "Written" } | { readonly _tag: "FirstFailure"; readonly error: unknown } | { readonly _tag: "FailedEarlier" };

export interface LogFile {
  /** Appends `line` and a newline. A line that would take the file past `maxBytes` rotates the file first. */
  readonly append: (line: string) => Appended;
}

/**
 * Appends to `file`, which holds `size` bytes now. When `size` is undefined the file could not be
 * prepared, and every append returns `FailedEarlier`.
 */
export const logFile = (file: string, size: number | undefined, options: { readonly maxBytes: number; readonly backups: number }): LogFile => {
  let failed = size === undefined;
  let written = size ?? 0;
  return {
    append: (line) => {
      if (failed) return { _tag: "FailedEarlier" };
      try {
        const bytes = Buffer.byteLength(line) + 1;
        if (written > 0 && written + bytes > options.maxBytes) {
          rotate(file, options.backups);
          written = 0;
        }
        appendFileSync(file, `${line}\n`, { mode: 0o600 });
        written += bytes;
        return { _tag: "Written" };
      } catch (error) {
        failed = true;
        return { _tag: "FirstFailure", error };
      }
    },
  };
};
