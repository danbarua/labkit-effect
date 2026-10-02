/**
 * What the ACP host keeps of a session in its record (`agent-host/record.ts`): the working folder
 * it was made for and its title; and `session/list` over the stored sessions, a page at a time.
 */

import { Data, Option, Schema } from "effect";
import type { ListSessionsResponse, SessionInfo } from "../acp/schema/v1.gen.ts";
import { SessionId } from "../acp/schema/v1.gen.ts";

/** The most characters a title has. */
const titleLength = 120;

/** What the host records of a session. */
export const SessionRecord = Schema.Struct({ cwd: Schema.String, title: Schema.optionalKey(Schema.String) });
export type SessionRecord = typeof SessionRecord.Type;

const decodeRecord = Schema.decodeUnknownOption(SessionRecord);

/**
 * A title from the text of a session's first prompt: trimmed, each run of whitespace one space,
 * cut after `titleLength` characters (never inside one). Nothing when no text is left.
 */
export const titleOf = (text: string): string | undefined => {
  const collapsed = text.trim().replace(/\s+/g, " ");
  const title = Array.from(collapsed).slice(0, titleLength).join("");
  return title === "" ? undefined : title;
};

/** The record turn zero writes: the working folder, and the title the first prompt gives, if it gives one. */
export const recordFor = (cwd: string, firstPrompt: string): SessionRecord => {
  const title = titleOf(firstPrompt);
  return title === undefined ? { cwd } : { cwd, title };
};

/** A host record as a `SessionRecord`, or nothing when it is not one. Fields it has besides are left out. */
export const readSessionRecord = (record: unknown): SessionRecord | undefined => Option.getOrUndefined(decodeRecord(record));

/** A cursor that `pageOf` did not give. */
export class InvalidCursor extends Data.TaggedError("InvalidCursor")<{ readonly cursor: string }> {}

/** A session, as the directory lists it with its record. */
export interface StoredSession {
  readonly sessionId: string;
  readonly at: Date | undefined;
  readonly record: unknown;
}

/** Where in the order a cursor stands: the time of the last session a page ended with, and its id. */
const Position = Schema.Tuple([Schema.Finite, Schema.String]);
const positionFrom = (cursor: string): readonly [number, string] | undefined => {
  try {
    return Option.getOrUndefined(Schema.decodeUnknownOption(Position)(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))));
  } catch {
    return undefined;
  }
};
const cursorAt = (at: number, sessionId: string): string => Buffer.from(JSON.stringify([at, sessionId])).toString("base64url");

/**
 * One page of `session/list`. Only sessions whose record reads are listed, and only those made for
 * `request.cwd` when it is given. They are in the order of when they were last written, the latest
 * first, and by id among those written at the same time. The page has at most `size` sessions, and
 * `nextCursor` when more follow it; a `request.cursor` continues after the session its page ended
 * with, so a session written to meanwhile is not repeated. A cursor `pageOf` did not give is an
 * `InvalidCursor`.
 */
export const pageOf = (
  stored: ReadonlyArray<StoredSession>,
  request: { readonly cwd?: string | null | undefined; readonly cursor?: string | null | undefined },
  size: number,
): ListSessionsResponse | InvalidCursor => {
  const after = request.cursor === undefined || request.cursor === null ? undefined : positionFrom(request.cursor);
  if (request.cursor !== undefined && request.cursor !== null && after === undefined) return new InvalidCursor({ cursor: request.cursor });
  const listed = stored
    .flatMap((each) => {
      const record = readSessionRecord(each.record);
      return record === undefined || (typeof request.cwd === "string" && record.cwd !== request.cwd) ? [] : [{ sessionId: each.sessionId, at: each.at, record }];
    })
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0) || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
    .filter((each) => {
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
