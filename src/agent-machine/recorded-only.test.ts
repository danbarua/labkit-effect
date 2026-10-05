/** Observations recorded for the record and the host, which no machine acts on. */

import { expect } from "bun:test";
import { observe, open, opened } from "../../tests/support/drive.ts";
import { test } from "../../tests/support/test.ts";

test("McpServerChanged is recorded and nothing follows from it, between turns or during one", () => {
  const session = open();
  observe(session, opened);
  const between = session.journal.length;
  observe(session, { _tag: "McpServerChanged", server: "github", state: { _tag: "Failed", reason: "its process could not be started" } });
  expect(session.journal.slice(between).map((fact) => fact._tag)).toEqual(["Observed"]);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "go" });
  const during = session.journal.length;
  const requests = session.requests.length;
  observe(session, { _tag: "McpServerChanged", server: "github", state: { _tag: "Ready", tools: ["mcp__github__search"] } });
  expect(session.journal.slice(during).map((fact) => fact._tag)).toEqual(["Observed"]);
  expect(session.requests.length).toBe(requests);
});
