/**
 * The compaction window marker: the core records which span a compaction would cover, and when the
 * marker is taken. No compaction is carried out: nothing summarises, and no request is made in a
 * window.
 */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { json } from "../../tests/support/received.ts";
import { observe, open, opened, type DrivenMachines } from "../../tests/support/drive.ts";

const tags = (session: DrivenMachines) =>
  session.journal.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));

const window = (through: number, kept: ReadonlyArray<number>) => ({ _tag: "CompactionWindow", window: "w1", decidedBy: "test", through, kept });

test("a compaction window while no turn runs is taken at once", () => {
  const session = open();
  observe(session, opened);
  const at = observe(session, window(1, []));
  expect(tags(session)).toEqual(["SessionOpened", "CompactionWindow", "WindowOpened"]);
  expect(session.journal.at(-1) as unknown).toMatchObject({ decision: { _tag: "WindowOpened", compaction: at } });
});

test("a compaction window during a step waits in the turn's mailbox and is taken before the next request", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "anthropic",
    model: "claude-sonnet-5",
    parts: [{ _tag: "ToolCall", call: "c1", tool: "ls", input: json({ path: "." }) }],
    stop: "tool_use",
    ending: { _tag: "Complete" },
    metadata: json({}),
  });
  observe(session, window(6, [2]));
  observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } });
  expect(tags(session)).toEqual([
    "SessionOpened",
    "InputArrived",
    "TurnStarted",
    "InputDelivered",
    "AskModel",
    "ModelResponded",
    "CompactionWindow",
    "ToolEnded",
    "WindowOpened",
    "TellModel",
  ]);
});

test("a compaction window records the span only; a summary on it is not part of the fact", () => {
  const session = open();
  observe(session, opened);
  expect(() =>
    observe(session, { ...window(1, []), summary: { mediaType: "text/plain", body: { _tag: "Text", text: "a summary" } } }),
  ).toThrow();
});

test("a compaction window that waits while an interrupted turn stops is taken when the turn ends", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, { _tag: "TurnInterrupted", turn: "turn-1" });
  const at = observe(session, window(4, []));
  expect(tags(session).at(-1)).toBe("CompactionWindow");
  observe(session, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "anthropic",
    model: "claude-sonnet-5",
    parts: [],
    ending: { _tag: "Interrupted" },
    metadata: json({}),
  });
  expect(tags(session).slice(-3)).toEqual(["ModelResponded", "TurnEnded", "WindowOpened"]);
  expect(session.journal.at(-1) as unknown).toMatchObject({ decision: { _tag: "WindowOpened", compaction: at } });
});
