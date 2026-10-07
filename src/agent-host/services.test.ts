/** The permission policy for a mode, over the tools a session opened with. */

import { expect } from "bun:test";
import { DateTime, Effect } from "effect";
import { boringOpening } from "../../tests/support/boring.ts";
import { runTest } from "../../tests/support/run.ts";
import { test, testOrigin } from "../../tests/support/test.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { CallId, Seq, type ToolKind, ToolName } from "../agent-machine/names.ts";
import type { PermissionMode } from "../agent-policy/permissions.ts";
import type { ToolSpec } from "../agent-session/contracts.ts";
import { receivedJson } from "../agent-session/received.ts";
import { permissionsFor } from "./services.ts";

const spec = (name: string, kind: ToolKind): ToolSpec => ({ name: ToolName.make(name), description: name, input: { type: "object" }, kind, replay: "safe" });

/** What the policy for `mode` does with a call to each of `tools`, in a session that opened with a tool that reads and one that edits. */
const verdicts = (mode: PermissionMode, canAsk: boolean, tools: ReadonlyArray<string>) =>
  runTest(
    Effect.gen(function* () {
      const facts: ReadonlyArray<Fact> = [
        { _tag: "Observed", seq: Seq.make(1), time: DateTime.makeUnsafe(0), origin: testOrigin(), observation: boringOpening([spec("look", "read"), spec("change", "edit")]) },
      ];
      const policy = yield* permissionsFor(mode, canAsk)(facts);
      return tools.map((tool) => {
        const step = policy.start({ _tag: "RunTool", call: CallId.make("c1"), tool: ToolName.make(tool), input: receivedJson({}) });
        return step._tag === "Waiting" ? "asks" : step.verdict._tag === "Continue" ? "runs" : "vetoed";
      });
    }),
  );

test("a call is judged by its tool's kind in the catalog that the session opened with, in the given mode, and asked about only when someone can answer", async () => {
  // `elsewhere` is in no catalog the session opened with: taken to change things.
  expect(await verdicts("acceptEdits", false, ["look", "change", "elsewhere"])).toEqual(["runs", "runs", "vetoed"]);
  expect(await verdicts("default", true, ["look", "change", "elsewhere"])).toEqual(["runs", "asks", "asks"]);
  expect(await verdicts("default", false, ["look", "change"])).toEqual(["runs", "vetoed"]);
});

test("an additional folder counts as inside the working folder: from ~, relative to the working folder, or absolute", async () => {
  const judged = (command: string, additional: ReadonlyArray<string>) =>
    runTest(
      Effect.gen(function* () {
        const facts: ReadonlyArray<Fact> = [
          { _tag: "Observed", seq: Seq.make(1), time: DateTime.makeUnsafe(0), origin: testOrigin(), observation: boringOpening([spec("run_command", "execute")]) },
        ];
        const policy = yield* permissionsFor("default", true, undefined, "/work/project", additional)(facts);
        const step = policy.start({ _tag: "RunTool", call: CallId.make("c1"), tool: ToolName.make("run_command"), input: receivedJson({ command }) });
        return step._tag === "Waiting" ? "asks" : step.verdict._tag === "Continue" ? "runs" : "vetoed";
      }),
    );
  expect(await judged("cat ../shared/notes.md", [])).toBe("asks");
  expect(await judged("cat ../shared/notes.md", ["../shared"])).toBe("runs");
  expect(await judged("cat /data/x.csv", ["/data"])).toBe("runs");
  expect(await judged("cat /data2/x.csv", ["/data"])).toBe("asks");
});
