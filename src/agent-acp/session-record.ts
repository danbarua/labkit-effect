/**
 * What the ACP host keeps of a session in its record (`agent-host/record.ts`): that the ACP host
 * made it, the working folder it was made for, and its title; and `session/list` over the stored
 * sessions, a page at a time. The sessions folder is shared with the CLI, whose records name the
 * CLI, so `session/list` lists only the sessions that the ACP host made.
 */

import { Array as Arr, Data, Option, Order, Schema } from "effect";
import type { ListSessionsResponse, SessionInfo } from "effective-acp/schema/v1";
import { SessionId } from "effective-acp/schema/v1";

/** The maximum number of characters in a title. */
const titleLength = 120;

/** The host that a record names when the ACP host made the session. */
export const acpHost = "acp";

/** What the host records of a session. */
export const SessionRecord = Schema.Struct({ host: Schema.Literal(acpHost), cwd: Schema.String, title: Schema.optionalKey(Schema.String) });
export type SessionRecord = typeof SessionRecord.Type;

const decodeRecord = Schema.decodeUnknownOption(SessionRecord);

/**
 * Returns a title from the text of a session's first prompt: trimmed, with each run of whitespace
 * made one space, and cut after `titleLength` characters, never inside a character. Undefined when
 * no text is left.
 */
export const titleOf = (text: string): string | undefined => {
  const collapsed = text.trim().replace(/\s+/g, " ");
  const title = Array.from(collapsed).slice(0, titleLength).join("");
  return title === "" ? undefined : title;
};

/** Returns the record that turn zero writes: the ACP host, the working folder, and the title from the first prompt when it gives one. */
export const recordFor = (cwd: string, firstPrompt: string): SessionRecord => {
  const title = titleOf(firstPrompt);
  return title === undefined ? { host: acpHost, cwd } : { host: acpHost, cwd, title };
};

/** Returns a host record as a `SessionRecord`, or undefined when it is not one, such as a record that the CLI wrote. Other fields of the record are dropped. */
export const readSessionRecord = (record: unknown): SessionRecord | undefined => Option.getOrUndefined(decodeRecord(record));

/** A cursor that `pageOf` did not give. */
export class InvalidCursor extends Data.TaggedError("InvalidCursor")<{ readonly cursor: string }> {}

/** A session, as the directory lists it with its record. */
export interface StoredSession {
  readonly sessionId: string;
  readonly at: Date | undefined;
  readonly record: unknown;
}

/** The position that a cursor encodes: when the last session of its page was written, and that session's id. */
const Position = Schema.Tuple([Schema.Finite, Schema.String]);
const positionFrom = (cursor: string): readonly [number, string] | undefined => {
  try {
    return Option.getOrUndefined(Schema.decodeUnknownOption(Position)(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))));
  } catch {
    return undefined;
  }
};
const cursorAt = (at: number, sessionId: string): string => Buffer.from(JSON.stringify([at, sessionId])).toString("base64url");

/** Orders sessions by when they were last written, the latest first (a session never written comes last), then by id. */
const latestFirst: Order.Order<{ readonly sessionId: string; readonly at: Date | undefined }> = Order.combine(
  Order.mapInput(Order.flip(Order.Number), (each) => each.at?.getTime() ?? 0),
  Order.mapInput(Order.String, (each) => each.sessionId),
);

/**
 * Returns one page of `session/list`.
 *
 * - Only sessions whose record reads as the ACP host's are listed, and, when `request.cwd` is given,
 *   only those made for it.
 * - Sessions are ordered by when they were last written, the latest first, then by id.
 * - The page has at most `size` sessions (at least one), and `nextCursor` when more follow it.
 * - `request.cursor` continues after the session that its page ended with, so a session written to
 *   meanwhile is not repeated.
 * - A cursor that `pageOf` did not give is an `InvalidCursor`.
 */
export const pageOf = (
  stored: ReadonlyArray<StoredSession>,
  request: { readonly cwd?: string | null | undefined; readonly cursor?: string | null | undefined },
  size: number,
): ListSessionsResponse | InvalidCursor => {
  const after = request.cursor === undefined || request.cursor === null ? undefined : positionFrom(request.cursor);
  if (request.cursor !== undefined && request.cursor !== null && after === undefined) return new InvalidCursor({ cursor: request.cursor });
  const readable = stored.flatMap((each) => {
    const record = readSessionRecord(each.record);
    return record === undefined || (typeof request.cwd === "string" && record.cwd !== request.cwd) ? [] : [{ sessionId: each.sessionId, at: each.at, record }];
  });
  const listed = Arr.sort(readable, latestFirst).filter((each) => {
    if (after === undefined) return true;
    const time = each.at?.getTime() ?? 0;
    return time < after[0] || (time === after[0] && each.sessionId > after[1]);
  });
  const page = listed.slice(0, Math.max(1, size));
  const last = page.at(-1);
  const sessions = page.map(
    (each): SessionInfo => ({
      sessionId: SessionId.make(each.sessionId),
      cwd: each.record.cwd,
      ...(each.record.title === undefined ? {} : { title: each.record.title }),
      ...(each.at === undefined ? {} : { updatedAt: each.at.toISOString() }),
    }),
  );
  return last !== undefined && listed.length > page.length ? { sessions, nextCursor: cursorAt(last.at?.getTime() ?? 0, last.sessionId) } : { sessions };
};
