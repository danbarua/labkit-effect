/** Tool usage counted from a session's facts. */

import { expect } from "bun:test";
import { observe, open, opened } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";
import { test } from "../../tests/support/test.ts";
import { toolStats } from "./tool-stats.ts";

test("a call whose end is not recorded is counted unfinished", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "boring",
    model: "boring-1",
    parts: [{ _tag: "ToolCall", call: "c1", tool: "ls", input: json({}) }],
    ending: { _tag: "Complete" },
    metadata: json({}),
  });
  expect(Object.fromEntries(toolStats(session.journal))).toMatchObject({ ls: { calls: 1, succeeded: 0, unfinished: 1 } });
});
