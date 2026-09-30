/** Rules of the core that no other test demonstrates: see `MODEL.md`. */

import { expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { observe, open, opened } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";
import { test } from "../../tests/support/test.ts";

test("R1: content from outside is recorded as it arrived, unparsed: text that is not JSON, and bytes", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "read the files" });
  const notJson = { mediaType: "application/json", body: { _tag: "Text", text: '{"path": ' } };
  const bytes = { mediaType: "image/png", body: { _tag: "Bytes", bytes: new Uint8Array([137, 80, 78, 71]) } };
  observe(session, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "boring",
    model: "boring-1",
    parts: [
      { _tag: "ToolCall", call: "c1", tool: "read", input: notJson },
      { _tag: "ToolCall", call: "c2", tool: "read", input: json({ path: "a.png" }) },
    ],
    ending: { _tag: "Complete" },
    metadata: notJson,
  });
  observe(session, { _tag: "ToolEnded", call: "c2", outcome: { _tag: "Succeeded", output: bytes } });
  const observed = session.journal.flatMap((fact) => (fact._tag === "Observed" ? [fact.observation] : []));
  expect(observed.at(-2) as unknown).toMatchObject({ parts: [{ input: notJson }, {}], metadata: notJson });
  expect(observed.at(-1) as unknown).toMatchObject({ outcome: { output: bytes } });
  // The core asked for both calls to be run, without reading either input.
  expect(session.requests.filter((request) => request._tag === "RunTool") as unknown).toMatchObject([
    { call: "c1", input: notJson },
    { call: "c2" },
  ]);
});

/** Where the brace opened at `from` in `text` is closed. */
function closing(text: string, from: number): number {
  let depth = 0;
  for (let at = from; at < text.length; at++) {
    if (text[at] === "{") depth += 1;
    if (text[at] === "}" && --depth === 0) return at;
  }
  return text.length;
}

/** The line of each `switch` in `text` whose body does not hold `satisfies never`. */
function unguardedSwitches(text: string): ReadonlyArray<number> {
  return [...text.matchAll(/switch \(/g)].flatMap((match) => {
    const from = text.indexOf("{", match.index);
    return text.slice(from, closing(text, from)).includes("satisfies never") ? [] : [text.slice(0, match.index).split("\n").length];
  });
}

test("R4: every switch in the core ends in satisfies never", () => {
  const sources = ["src/agent-machine", "src/agent-policy"].flatMap((directory) =>
    readdirSync(directory)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => join(directory, file)),
  );
  const texts = sources.map((file) => [file, readFileSync(file, "utf8")] as const);
  // The scan finds a switch with no such ending, and reads sources that have switches: it does not pass over nothing.
  expect(unguardedSwitches("const a = 1;\nswitch (x) {\n  case 1: {\n    break;\n  }\n}\n")).toEqual([2]);
  expect(texts.filter(([, text]) => text.includes("switch (")).length).toBeGreaterThan(3);
  expect(texts.flatMap(([file, text]) => unguardedSwitches(text).map((line) => `${file}:${line}`))).toEqual([]);
});

test("TC4: a call that arrived in a response that then failed is recorded, with its dispatch and its end", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, { _tag: "ToolCallArrived", turn: "turn-1", call: "c1", tool: "ls", input: json({}) });
  observe(session, { _tag: "ToolCallDispatched", call: "c1" });
  observe(session, {
    _tag: "ModelFailed",
    turn: "turn-1",
    failure: "the connection was lost",
    error: { mediaType: "text/plain", body: { _tag: "Text", text: "the connection was lost" } },
  });
  observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json(["a.ts"]) } });
  const recorded = session.journal.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));
  expect(recorded.slice(5)).toEqual(["ToolCallArrived", "ToolCallDispatched", "ModelFailed", "TurnEnded", "ToolEnded"]);
  expect(recorded).not.toContain("ObservationNotExpected");
});
