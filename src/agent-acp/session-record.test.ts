/** The ACP host's record of a session, its title, and the pages of `session/list`. */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { InvalidCursor, pageOf, readSessionRecord, recordFor, type StoredSession, titleOf } from "./session-record.ts";

const at = (seconds: number): Date => new Date(seconds * 1000);

const stored = (sessionId: string, seconds: number | undefined, record: unknown): StoredSession => ({ sessionId, at: seconds === undefined ? undefined : at(seconds), record });

/** The page, for a cursor these tests expect `pageOf` to accept. */
const pageRead = (response: ReturnType<typeof pageOf>) => {
  if (response instanceof InvalidCursor) throw new Error(`the cursor ${response.cursor} was refused`);
  return response;
};

/** The ids of a page's sessions, in order. */
const idsOf = (response: ReturnType<typeof pageOf>) => pageRead(response).sessions.map((each) => String(each.sessionId));

/** A page as plain data, for comparing with what a client would be sent. */
const plain = (response: ReturnType<typeof pageOf>): unknown => ({ ...pageRead(response) });

test("a title is the prompt's text trimmed, each run of whitespace one space, cut after 120 characters without splitting one, and none when no text is left", () => {
  expect(titleOf("  Plan the\n\tsurvey   of  sources \n")).toBe("Plan the survey of sources");
  expect(titleOf("x".repeat(200))).toBe("x".repeat(120));
  // A character outside the basic plane is two UTF-16 units and one character: the cut falls after whole ones.
  const emoji = "\u{1F600}";
  expect(titleOf(emoji.repeat(130))).toBe(emoji.repeat(120));
  expect(Array.from(titleOf(`a${emoji.repeat(130)}`) ?? "").length).toBe(120);
  expect(titleOf("")).toBeUndefined();
  expect(titleOf(" \n\t ")).toBeUndefined();
});

test("a record names the ACP host and holds the working folder and the first prompt's title, and decodes from JSON; a value that is not a record, lacks a folder, or names another host (the CLI) decodes as none", () => {
  expect(recordFor("/work/a", "  Explain the loop  ")).toEqual({ host: "acp", cwd: "/work/a", title: "Explain the loop" });
  expect(recordFor("/work/a", "   ")).toEqual({ host: "acp", cwd: "/work/a" });
  expect(readSessionRecord(JSON.parse(JSON.stringify(recordFor("/work/a", "Explain"))))).toEqual({ host: "acp", cwd: "/work/a", title: "Explain" });
  expect(readSessionRecord({ host: "acp", cwd: "/work/a", other: 1 })).toEqual({ host: "acp", cwd: "/work/a" });
  expect(readSessionRecord({ host: "cli", cwd: "/work/a" })).toBeUndefined();
  for (const notARecord of [undefined, null, "text", 3, [], {}, { title: "no folder" }, { cwd: 4 }, { cwd: "/w", title: 7 }]) {
    expect(readSessionRecord(notARecord)).toBeUndefined();
  }
});

test("a page lists the sessions whose record reads as the ACP host's, latest first and by id among equals, filtered by working folder when asked, as session/list's info; a session the CLI recorded is not listed", () => {
  const sessions = [
    stored("b", 100, { host: "acp", cwd: "/work/a", title: "Second" }),
    stored("a", 100, { host: "acp", cwd: "/work/b" }),
    stored("old", 50, { host: "acp", cwd: "/work/a", title: "Oldest" }),
    stored("cli-made", 300, undefined),
    stored("cli-recorded", 350, { host: "cli", cwd: "/work/a" }),
    stored("garbled", 400, { cwd: 7 }),
    stored("unknown-time", undefined, { host: "acp", cwd: "/work/a" }),
    stored("newest", 200, { host: "acp", cwd: "/work/a", title: "Newest" }),
  ];
  const all = pageOf(sessions, {}, 50);
  expect(plain(all)).toEqual({
    sessions: [
      { sessionId: "newest", cwd: "/work/a", title: "Newest", updatedAt: at(200).toISOString() },
      { sessionId: "a", cwd: "/work/b", updatedAt: at(100).toISOString() },
      { sessionId: "b", cwd: "/work/a", title: "Second", updatedAt: at(100).toISOString() },
      { sessionId: "old", cwd: "/work/a", title: "Oldest", updatedAt: at(50).toISOString() },
      { sessionId: "unknown-time", cwd: "/work/a" },
    ],
  });
  expect(idsOf(pageOf(sessions, { cwd: "/work/a" }, 50))).toEqual(["newest", "b", "old", "unknown-time"]);
  // A null filter and a null cursor are the same as none.
  expect(plain(pageOf(sessions, { cwd: null, cursor: null }, 50))).toEqual(plain(all));
  expect(plain(pageOf(sessions, { cwd: "/work/none" }, 50))).toEqual({ sessions: [] });
});

test("pages of a size continue after the session the last one ended with, so each session comes once, in order, and the last page has no cursor; a session written to meanwhile is not repeated", () => {
  const sessions = ["a", "b", "c", "d", "e"].map((id, at) => stored(id, (at + 1) * 10, { host: "acp", cwd: "/w" }));
  const first = pageRead(pageOf(sessions, {}, 2));
  expect(idsOf(first)).toEqual(["e", "d"]);
  expect(first.nextCursor).toBeString();
  const second = pageRead(pageOf(sessions, { cursor: first.nextCursor }, 2));
  expect(idsOf(second)).toEqual(["c", "b"]);
  // "c" is written to before the next page is asked for: it moves to the front and is not seen again.
  const meanwhile = sessions.map((each) => (each.sessionId === "c" ? stored("c", 99, { host: "acp", cwd: "/w" }) : each));
  const third = pageRead(pageOf(meanwhile, { cursor: second.nextCursor }, 2));
  expect(idsOf(third)).toEqual(["a"]);
  expect(third.nextCursor).toBeUndefined();
  // Exactly a page's worth left gives no cursor.
  expect(pageRead(pageOf(sessions, {}, 5)).nextCursor).toBeUndefined();
  // A size below one is one.
  expect(idsOf(pageOf(sessions, {}, 0))).toEqual(["e"]);
});

test("a cursor that was not given by pageOf is an InvalidCursor naming it", () => {
  const sessions = [stored("a", 10, { host: "acp", cwd: "/w" })];
  const wrongShape = Buffer.from(JSON.stringify({ at: 1 })).toString("base64url");
  for (const cursor of ["", "not a cursor", "%%%", wrongShape]) {
    const response = pageOf(sessions, { cursor }, 10);
    expect(response).toBeInstanceOf(InvalidCursor);
    expect((response as InvalidCursor).cursor).toBe(cursor);
  }
});
