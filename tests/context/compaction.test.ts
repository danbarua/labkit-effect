import { expect, test } from "bun:test";
import { json } from "../support/received.ts";
import { observe, open, opened, type Session } from "../support/drive.ts";

const tags = (session: Session) =>
  session.journal.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));

const compacted = (through: number, kept: ReadonlyArray<number>) => ({
  _tag: "Compacted",
  window: "w1",
  summary: { mediaType: "text/plain", body: { _tag: "Text", text: "The user asked for the files listed." } },
  through,
  kept,
});

test("a compaction while no turn runs is taken at once", () => {
  const session = open();
  observe(session, opened);
  const at = observe(session, compacted(1, []));
  expect(tags(session)).toEqual(["SessionOpened", "Compacted", "WindowOpened"]);
  expect(session.journal.at(-1) as unknown).toMatchObject({ decision: { _tag: "WindowOpened", compaction: at } });
});

test("a compaction during a step waits in the turn's mailbox and is taken before the next request", () => {
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
  observe(session, compacted(6, [2]));
  observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } });
  expect(tags(session)).toEqual([
    "SessionOpened",
    "InputArrived",
    "TurnStarted",
    "InputDelivered",
    "ModelAsked",
    "ModelResponded",
    "Compacted",
    "ToolEnded",
    "WindowOpened",
    "ModelAsked",
  ]);
});
