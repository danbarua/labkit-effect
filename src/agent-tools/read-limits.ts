/** How much a tool reads or writes in one call, and the lines of a text that a read selects. */

import { Effect } from "effect";
import { Rejected } from "./tool.ts";

/** The most bytes `read_file` returns in one result, `write_file` writes, and `run_command` returns. */
export const maxReadBytes = 256 * 1024;

/** `maxReadBytes` as the tool descriptions state it. */
export const maxReadText = `${maxReadBytes / 1024} KiB`;

/** The lines of `text` that `line` (1-based) and `limit` select, all of it when neither is given; refused when they are over `maxReadBytes`, with the lines to read instead. */
export const selectedLines = (text: string, line: number | undefined, limit: number | undefined): Effect.Effect<string, Rejected> => {
  const whole = line === undefined && limit === undefined;
  const start = (line ?? 1) - 1;
  const part = whole ? text : text.split("\n").slice(start, limit === undefined ? undefined : start + limit).join("\n");
  if (Buffer.byteLength(part) <= maxReadBytes) return Effect.succeed(part);
  const fewer = limit === undefined ? 100 : Math.max(1, Math.floor(limit / 2));
  return Effect.fail(new Rejected({ problem: `The result is over ${maxReadText}. Read fewer lines, for example line ${line ?? 1} and limit ${fewer}.` }));
};
