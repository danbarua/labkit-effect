/** An MCP server's tools as a tool source. */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import type { McpSchema } from "effect/ai";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { CallId, ToolName } from "../agent-machine/names.ts";
import { receivedJson, receivedText } from "../agent-session/received.ts";
import { toolsOf } from "../agent-session/tool-sources.ts";
import { mcpToolResult } from "../agent-session/tool-output.ts";
import { mcpToolSource, namespaceOf } from "./source.ts";
import { type McpServer, startMcpServer } from "./server.ts";

const fake = { name: "fake", command: process.execPath, args: [new URL("../../tests/support/mcp-server.ts", import.meta.url).pathname], env: {} };

test("MT1: a server's tools are offered under mcp__<server>, characters providers do not take offered as _; one too long or the same as another once offered is left out, with why", () => {
  expect(namespaceOf("my server.v2")).toBe("mcp__my_server_v2");
  const tool = (name: string) => ({ name, inputSchema: { type: "object" } }) as unknown as McpSchema.Tool;
  const { source, left } = mcpToolSource({ name: "gh" } as McpServer, [tool("search.code"), tool("search_code"), tool("x".repeat(60)), tool("get")]);
  expect(source.tools.map((each) => each.name as string)).toEqual(["search_code", "get"]);
  expect(left).toEqual([
    { tool: "search_code", reason: "search_code is offered as search_code, as another of the server's tools is" },
    { tool: "x".repeat(60), reason: `mcp__gh__${"x".repeat(60)} is longer than 64 characters` },
  ]);
});

test("MT2: a tool that says it only reads is of kind read and safe to run again; one that says it is idempotent is idempotent; others are other and unsafe", () => {
  const tool = (name: string, annotations: object) => ({ name, inputSchema: { type: "object" }, annotations }) as unknown as McpSchema.Tool;
  const { source } = mcpToolSource({ name: "s" } as McpServer, [tool("read", { readOnlyHint: true }), tool("put", { idempotentHint: true }), tool("rm", {})]);
  expect(source.tools.map((each) => [each.name as string, each.kind, each.replay])).toEqual([
    ["read", "read", "safe"],
    ["put", "other", "idempotent"],
    ["rm", "other", "unsafe"],
  ]);
});

test("MT3: a call runs on the server and its result is recorded as the server sent it; input that is not an object is refused; a call to a server not running fails saying why", async () => {
  const seen = await runTest(
    Effect.gen(function* () {
      const server = yield* startMcpServer(fake, []);
      const ready = yield* server.settled;
      const { source } = mcpToolSource(server, ready._tag === "Ready" ? ready.tools : []);
      const tools = yield* toolsOf([source]);
      const run = (tool: string, input: Parameters<typeof tools.run>[1]) => tools.run(ToolName.make(tool), input, CallId.make("c1"));
      const echoed = yield* run("mcp__fake__echo", receivedJson({ message: "hi" }));
      const refused = yield* run("mcp__fake__echo", receivedText("hi"));
      yield* server.stop;
      const stopped = yield* run("mcp__fake__echo", receivedJson({ message: "again" }));
      return { names: tools.catalog.map((tool) => tool.name as string), echoed, refused, stopped };
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(seen.names).toEqual(["mcp__fake__echo", "mcp__fake__roots", "mcp__fake__slow"]);
  expect(seen.echoed as unknown).toEqual({ _tag: "Succeeded", output: { mediaType: mcpToolResult, body: { _tag: "Text", text: JSON.stringify({ content: [{ type: "text", text: "hi" }] }) } } });
  expect(seen.refused as unknown).toEqual({ _tag: "Failed", reason: { _tag: "InputRejected", problem: "mcp__fake__echo takes a JSON object as its input." } });
  expect(seen.stopped).toMatchObject({ _tag: "Failed", reason: { _tag: "Reported", error: { body: { text: "fake: echo was not called: the server is not running (it is stopped)" } } } });
});
