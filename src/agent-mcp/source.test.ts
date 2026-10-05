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

test("a server's tools are offered under mcp__<server>, with characters that providers do not accept replaced by _; a tool whose offered name is too long or duplicates another is not offered, with the reason", () => {
  expect(namespaceOf("my server.v2")).toBe("mcp__my_server_v2");
  const tool = (name: string) => ({ name, inputSchema: { type: "object" } }) as unknown as McpSchema.Tool;
  const { source, omitted } = mcpToolSource({ name: "gh" } as McpServer, [tool("search.code"), tool("search_code"), tool("x".repeat(60)), tool("get")]);
  expect(source.tools.map((each) => each.name as string)).toEqual(["search_code", "get"]);
  expect(omitted).toEqual([
    { tool: "search_code", reason: "search_code is offered as search_code, as another of the server's tools is" },
    { tool: "x".repeat(60), reason: `mcp__gh__${"x".repeat(60)} is longer than 64 characters` },
  ]);
});

test("a tool that says it only reads is of kind read and safe to run again; one that says it is idempotent is idempotent; others are other and unsafe", () => {
  const tool = (name: string, annotations: object) => ({ name, inputSchema: { type: "object" }, annotations }) as unknown as McpSchema.Tool;
  const { source } = mcpToolSource({ name: "s" } as McpServer, [tool("read", { readOnlyHint: true }), tool("put", { idempotentHint: true }), tool("rm", {})]);
  expect(source.tools.map((each) => [each.name as string, each.kind, each.replay])).toEqual([
    ["read", "read", "safe"],
    ["put", "other", "idempotent"],
    ["rm", "other", "unsafe"],
  ]);
});

test("a call runs on the server and its result is recorded as the server sent it; input that is not JSON is refused; a call to a server that is not running fails with the reason", async () => {
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

/** A server stub whose `call` answers `result`, counting its calls. */
const stubServer = (result: Readonly<Record<string, unknown>>) => {
  const calls = { count: 0 };
  const server = { name: "stub", call: () => Effect.sync(() => (calls.count += 1)).pipe(Effect.as(result)) } as unknown as McpServer;
  return { server, calls };
};
const stubTool = { name: "act", inputSchema: { type: "object" } } as unknown as McpSchema.Tool;

test("a call whose input is JSON but not an object is refused as InputRejected, and the server is not called", async () => {
  const { server, calls } = stubServer({ content: [] });
  const { source } = mcpToolSource(server, [stubTool]);
  const outcome = await Effect.runPromise(source.run(ToolName.make("act"), receivedJson([1, 2]), CallId.make("c1")));
  expect(outcome as unknown).toEqual({ _tag: "Failed", reason: { _tag: "InputRejected", problem: "mcp__stub__act takes a JSON object as its input." } });
  expect(calls.count).toBe(0);
});

test("a result with isError true is the tool's own failure: Reported, with the result as the server sent it", async () => {
  const result = { content: [{ type: "text", text: "the file is locked" }], isError: true };
  const { source } = mcpToolSource(stubServer(result).server, [stubTool]);
  const outcome = await Effect.runPromise(source.run(ToolName.make("act"), receivedJson({}), CallId.make("c1")));
  expect(outcome as unknown).toEqual({ _tag: "Failed", reason: { _tag: "Reported", error: { mediaType: mcpToolResult, body: { _tag: "Text", text: JSON.stringify(result) } } } });
});
