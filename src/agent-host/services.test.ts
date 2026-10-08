/** The permission policy for a mode, over the tools a session opened with. */

import { expect } from "bun:test";
import { DateTime, Effect } from "effect";
import { boringOpening } from "../../tests/support/boring.ts";
import { runTest } from "../../tests/support/run.ts";
import { test, testOrigin } from "../../tests/support/test.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { CallId, FolderPath, Seq, SessionId, type ToolKind, ToolName } from "../agent-machine/names.ts";
import type { PermissionMode } from "../agent-policy/permissions.ts";
import type { ToolSpec } from "../agent-session/contracts.ts";
import { receivedJson } from "../agent-session/received.ts";
import { permissionsFor } from "./services.ts";
import { inSession, makeSessionContext } from "./session-context.ts";

const spec = (name: string, kind: ToolKind): ToolSpec => ({ name: ToolName.make(name), description: name, input: { type: "object" }, kind, replay: "safe" });

/** Runs `effect` in the context of a session working in `/work/project`, with the folders `additional` and the facts `facts`, as a host makes it (`session-context.ts`). */
const inProject =
  (additional: ReadonlyArray<string>, facts: ReadonlyArray<Fact>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const made = yield* makeSessionContext({ session: SessionId.make("s1"), working: "/work/project", additional });
      yield* made.storeOpened(Effect.succeed(facts));
      return yield* inSession(made.context)(effect);
    });

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
        const policy = yield* permissionsFor("default", true)(facts).pipe(inProject(additional, facts));
        const step = policy.start({ _tag: "RunTool", call: CallId.make("c1"), tool: ToolName.make("run_command"), input: receivedJson({ command }) });
        return step._tag === "Waiting" ? "asks" : step.verdict._tag === "Continue" ? "runs" : "vetoed";
      }),
    );
  expect(await judged("cat ../shared/notes.md", [])).toBe("asks");
  expect(await judged("cat ../shared/notes.md", ["../shared"])).toBe("runs");
  expect(await judged("cat /data/x.csv", ["/data"])).toBe("runs");
  expect(await judged("cat /data2/x.csv", ["/data"])).toBe("asks");
});

test("a folder the user added to the session counts as inside the working folder, read from the session's facts, so a continued session keeps it", async () => {
  const judged = (command: string, added: ReadonlyArray<string>) =>
    runTest(
      Effect.gen(function* () {
        const facts: ReadonlyArray<Fact> = [
          { _tag: "Observed", seq: Seq.make(1), time: DateTime.makeUnsafe(0), origin: testOrigin(), observation: boringOpening([spec("run_command", "execute")]) },
          ...added.map((folder, at): Fact => ({ _tag: "Observed", seq: Seq.make(2 + at), time: DateTime.makeUnsafe(0), origin: testOrigin(), observation: { _tag: "FolderAdded", folder: FolderPath.make(folder) } })),
        ];
        const policy = yield* permissionsFor("default", true)(facts).pipe(inProject([], facts));
        const step = policy.start({ _tag: "RunTool", call: CallId.make("c1"), tool: ToolName.make("run_command"), input: receivedJson({ command }) });
        return step._tag === "Waiting" ? "asks" : step.verdict._tag === "Continue" ? "runs" : "vetoed";
      }),
    );
  expect(await judged("cat /data/x.csv", [])).toBe("asks");
  expect(await judged("cat /data/x.csv", ["/data"])).toBe("runs");
  expect(await judged("cat /data2/x.csv", ["/data"])).toBe("asks");
});

test("a tool's path inputs come from the tools the session runs with now, so a session whose recorded catalog does not name them still has its paths judged", async () => {
  const judged = (toolPaths: ((tool: string) => ReadonlyArray<string> | undefined) | undefined) =>
    runTest(
      Effect.gen(function* () {
        // The catalog recorded at the opening names no path inputs, as a session recorded before they were named.
        const facts: ReadonlyArray<Fact> = [
          { _tag: "Observed", seq: Seq.make(1), time: DateTime.makeUnsafe(0), origin: testOrigin(), observation: boringOpening([spec("read_file", "read")]) },
        ];
        const policy = yield* permissionsFor("default", true, undefined, toolPaths)(facts).pipe(inProject([], facts));
        const step = policy.start({ _tag: "RunTool", call: CallId.make("c1"), tool: ToolName.make("read_file"), input: receivedJson({ path: "~/.aws/credentials" }) });
        return step._tag === "Waiting" ? "asks" : step.verdict._tag === "Continue" ? "runs" : "vetoed";
      }),
    );
  expect(await judged((tool) => (tool === "read_file" ? ["path"] : undefined))).toBe("asks");
  expect(await judged(undefined)).toBe("runs");
});
