/** Tool sources: their tools joined in order, a namespaced source's under its namespace, and each call run by the source that offered its tool. */

import { expect } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { test } from "../../tests/support/test.ts";
import { TestSessionContext } from "../../tests/support/session-context.ts";
import { CallId, ToolName } from "../agent-machine/names.ts";
import type { ToolSpec } from "./contracts.ts";
import { asText, receivedJson, receivedText } from "./received.ts";
import { type ToolSource, toolsOf } from "./tool-sources.ts";

const echo: ToolSpec = { name: ToolName.make("echo"), description: "Echoes.", input: { type: "object" }, kind: "read", replay: "safe" };

/** A source that answers each call with its own name for the tool and its name for itself. */
const answering = (said: string, namespace?: string): ToolSource => ({
  ...(namespace === undefined ? {} : { namespace }),
  tools: [echo],
  run: (tool) => Effect.succeed({ _tag: "Succeeded", output: receivedText(`${said} ran ${tool}`) }),
});

const ran = (sources: ReadonlyArray<ToolSource>, tool: string) =>
  Effect.runSync(
    Effect.gen(function* () {
      const outcome = yield* (yield* toolsOf(sources)).run(ToolName.make(tool), receivedJson({}), CallId.make("c1"));
      return outcome._tag === "Succeeded" ? asText(outcome.output) : outcome.reason._tag;
    }).pipe(Effect.provide(TestSessionContext())),
  );

test("the sources' tools are offered in order, a namespaced source's as <namespace>__<tool>; a call reaches the source that offered it, by the source's own name", () => {
  const sources = [answering("host"), answering("server", "mcp__github")];
  expect(Effect.runSync(toolsOf(sources)).catalog.map((tool) => tool.name as string)).toEqual(["echo", "mcp__github__echo"]);
  expect(ran(sources, "echo")).toBe("host ran echo");
  expect(ran(sources, "mcp__github__echo")).toBe("server ran echo");
  expect(ran(sources, "github__echo")).toBe("NotFound");
});

test("two tools offered under one name are a defect of the host that listed their sources, named in the failure", () => {
  const exit = Effect.runSyncExit(toolsOf([answering("host"), answering("server", "mcp__github"), answering("other", "mcp__github")]));
  expect(Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "succeeded").toBe(
    "Error: Two tool sources offer a tool named mcp__github__echo: source 2 (namespace mcp__github) and source 3 (namespace mcp__github)",
  );
});
