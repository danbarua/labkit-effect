import { expect } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { Exit, Schema } from "effect";
import * as zodV1 from "../../../node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import * as zodV2 from "../../../node_modules/@agentclientprotocol/sdk/dist/v2/schema/zod.gen.js";
import { test } from "../../../tests/support/test.ts";
import * as v1 from "./v1.gen.ts";
import * as v1Rpcs from "./v1.rpcs.gen.ts";
import * as v2 from "./v2.gen.ts";

type Direction = "toAgent" | "toClient";

interface Logged {
  readonly direction: Direction;
  readonly message: { readonly [key: string]: unknown };
}

/** A stream that records, as JSON, every message passing through it. */
function tap(direction: Direction, log: Array<Logged>) {
  return new TransformStream<acp.AnyMessage, acp.AnyMessage>({
    transform(message, controller) {
      log.push({ direction, message: JSON.parse(JSON.stringify(message)) });
      controller.enqueue(message);
    },
  });
}

/** Runs an SDK client against an SDK agent through a prompt turn, and returns every message that crossed. */
async function sdkConversation(): Promise<ReadonlyArray<Logged>> {
  const log: Array<Logged> = [];
  const toAgent = tap("toAgent", log);
  const toClient = tap("toClient", log);
  const agent = acp
    .agent({ name: "schema-test-agent" })
    .onRequest("initialize", ({ params }) => ({
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: true, embeddedContext: true } },
      authMethods: [{ id: "token", name: "Token" }],
      agentInfo: { name: "schema-test-agent", version: "1.0.0" },
    }))
    .onRequest("session/new", () => ({ sessionId: "session-1" }))
    .onRequest("session/prompt", async ({ params, client }) => {
      const { sessionId } = params;
      await client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading the notes." } } });
      await client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The notes are short." } } });
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "Read notes.md",
          kind: "read",
          status: "pending",
          locations: [{ path: "/tmp/notes.md", line: 3 }],
          rawInput: { path: "/tmp/notes.md" },
        },
      });
      await client.notify("session/update", { sessionId, update: { sessionUpdate: "plan", entries: [{ content: "Read the notes", priority: "high", status: "in_progress" }] } });
      await client.notify("session/update", {
        sessionId,
        update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "web", description: "Search the web", input: { hint: "query" } }] },
      });
      const permission = await client.request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "call-1", title: "Read notes.md", kind: "read" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: "# Notes" } },
            { type: "diff", path: "/tmp/notes.md", oldText: "a", newText: "b" },
          ],
        },
      });
      return { stopReason: permission.outcome.outcome === "selected" ? "end_turn" : "cancelled" };
    });
  const client = acp
    .client({ name: "schema-test-client" })
    .onRequest("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "allow" } }))
    .onNotification("session/update", () => undefined);
  const finished = Promise.withResolvers<void>();
  const agentRun = agent.connectWith({ readable: toAgent.readable, writable: toClient.writable }, () => finished.promise);
  await client.connectWith({ readable: toClient.readable, writable: toAgent.writable }, async (context) => {
    await context.request("initialize", {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "schema-test-client", version: "1.0.0" },
    });
    const { sessionId } = await context.request("session/new", { cwd: "/tmp", mcpServers: [] });
    await context.request("session/prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "Summarise these notes." },
        { type: "resource_link", uri: "file:///tmp/notes.md", name: "notes.md", mimeType: "text/markdown", size: 120 },
      ],
    });
  });
  finished.resolve();
  await agentRun;
  return log;
}

type Codec = Schema.Codec<unknown, unknown>;

/** The schema a logged message's params or result is checked against, by direction and method. */
function schemaFor(logged: Logged, methodById: Map<string, string>): { readonly method: string; readonly schema: Codec; readonly value: unknown } {
  const { message, direction } = logged;
  const requests = direction === "toAgent" ? v1Rpcs.AgentRequests.byName : v1Rpcs.ClientRequests.byName;
  const notifications = direction === "toAgent" ? v1Rpcs.AgentNotifications.byName : v1Rpcs.ClientNotifications.byName;
  if (typeof message["method"] === "string") {
    const method = message["method"];
    if ("id" in message) methodById.set(`${direction}:${String(message["id"])}`, method);
    const declared = "id" in message ? requests.get(method) : notifications.get(method);
    if (declared === undefined) throw new Error(`no method ${method}`);
    return { method, schema: declared.params as Codec, value: message["params"] };
  }
  // A response answers a request that went the other way.
  const asked = direction === "toAgent" ? "toClient" : "toAgent";
  const method = methodById.get(`${asked}:${String(message["id"])}`);
  const declared = method === undefined ? undefined : (asked === "toAgent" ? v1Rpcs.AgentRequests : v1Rpcs.ClientRequests).byName.get(method);
  if (method === undefined || declared === undefined) throw new Error(`a response to no known request: ${JSON.stringify(message)}`);
  return { method: `${method} (response)`, schema: declared.result as Codec, value: message["result"] };
}

test("AS4: what an SDK client and agent send each other in a turn decodes, and encodes back to the same JSON", async () => {
  const log = await sdkConversation();
  const methodById = new Map<string, string>();
  const seen: Array<string> = [];
  for (const logged of log) {
    const { method, schema, value } = schemaFor(logged, methodById);
    const decoded = Schema.decodeUnknownSync(schema)(value);
    expect({ method, json: Schema.encodeUnknownSync(schema)(decoded) }).toEqual({ method, json: value });
    const update = method === "session/update" ? Schema.decodeUnknownSync(v1.SessionNotification)(value).update.sessionUpdate : undefined;
    seen.push(update === undefined ? method : `${method} ${update}`);
  }
  expect(seen).toEqual([
    "initialize",
    "initialize (response)",
    "session/new",
    "session/new (response)",
    "session/prompt",
    "session/update agent_message_chunk",
    "session/update agent_thought_chunk",
    "session/update tool_call",
    "session/update plan",
    "session/update available_commands_update",
    "session/request_permission",
    "session/request_permission (response)",
    "session/update tool_call_update",
    "session/prompt (response)",
  ]);
  const prompt = log.find((logged) => logged.message["method"] === "session/prompt")?.message["params"];
  expect(Schema.decodeUnknownSync(v1.PromptRequest)(prompt).prompt.map((block) => block.type)).toEqual(["text", "resource_link"]);
});

/** What `schema` decodes `input` to, typed loosely so it can be compared with plain JSON. */
const decode = (schema: Codec, input: unknown): unknown => Schema.decodeUnknownSync(schema)(input);

const refuses = (schema: Codec, input: unknown): boolean => Exit.isFailure(Schema.decodeUnknownExit(schema)(input));

test("AS5: a field marked default-on-error that fails to decode takes its default, as the SDK's does", () => {
  const input = { image: "yes", audio: true };
  expect(zodV1.zPromptCapabilities.safeParse(input).success).toBe(true);
  expect(decode(v1.PromptCapabilities, input)).toEqual({ image: false, audio: true });
  expect(decode(v1.InitializeRequest, { protocolVersion: 1, clientCapabilities: "all of them" })).toEqual({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: false } },
  });
});

test("AS5: a field marked default-on-error with no default that fails to decode is left out", () => {
  const input = { toolCallId: "call-1", title: 42, status: "completed", kind: ["read"], locations: "here", rawInput: { path: "/tmp" } };
  expect(zodV1.zToolCallUpdate.safeParse(input).success).toBe(true);
  expect(decode(v1.ToolCallUpdate, input)).toEqual({ toolCallId: "call-1", status: "completed", rawInput: { path: "/tmp" } });
  expect(decode(v1.ToolCallUpdate, { ...input, status: "done" })).toEqual({ toolCallId: "call-1", rawInput: { path: "/tmp" } });
  expect(decode(v1.Annotations, { priority: "high", lastModified: 7 })).toEqual({});
});

test("AS5: a required default-on-error array that fails to decode is empty, and a missing one still fails", () => {
  const input = { currentModeId: "ask", availableModes: "none" };
  expect(zodV1.zSessionModeState.safeParse(input).success).toBe(true);
  expect(decode(v1.SessionModeState, input)).toEqual({ currentModeId: "ask", availableModes: [] });
  expect(zodV1.zSessionModeState.safeParse({ currentModeId: "ask" }).success).toBe(false);
  expect(refuses(v1.SessionModeState, { currentModeId: "ask" })).toBe(true);
});

test("AS5: a value of the wrong type for a field not marked default-on-error is refused, as the SDK refuses it", () => {
  const input = { sessionId: 7, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } };
  expect(zodV1.zSessionNotification.safeParse(input).success).toBe(false);
  expect(refuses(v1.SessionNotification, input)).toBe(true);
});

test("AS6: an item that fails to decode in an array marked skip-invalid-items is dropped, as the SDK drops it", () => {
  const input = { audience: ["user", 5, "assistant"] };
  expect(zodV1.zAnnotations.parse(input)).toMatchObject({ audience: ["user", "assistant"] });
  expect(decode(v1.Annotations, input)).toEqual({ audience: ["user", "assistant"] });
  const update = { sessionUpdate: "available_commands_update", availableCommands: [{ name: "web", description: "Search" }, { name: 1 }] };
  expect(decode(v1.SessionUpdate, update)).toEqual({
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "web", description: "Search" }],
  });
});

test("AS6: encoding refuses an invalid item in a skip-invalid-items array", () => {
  expect(Exit.isFailure(Schema.encodeUnknownExit(v1.Annotations)({ audience: ["user", 5] }))).toBe(true);
  expect(Schema.encodeUnknownSync(v1.Annotations)({ audience: ["user"] })).toEqual({ audience: ["user"] });
});

test("AS7: an id is a branded string, the same brand in v1 and v2; a plain string or another kind of id is not one", () => {
  const sessionId: v1.SessionId = Schema.decodeSync(v1.SessionId)("session-1");
  const sameInV2: v2.SessionId = sessionId;
  const toolCallId = Schema.decodeSync(v1.ToolCallId)("call-1");
  // @ts-expect-error a plain string is not a SessionId
  const plain: v1.SessionId = "session-1";
  // @ts-expect-error a ToolCallId is not a SessionId
  const wrong: v1.SessionId = toolCallId;
  expect<ReadonlyArray<string>>([sessionId, sameInV2, plain, wrong]).toEqual(["session-1", "session-1", "session-1", "call-1"]);
});

test("AS8: a catch-all variant decodes an unknown tag with its other properties, and refuses a known tag of the wrong shape", () => {
  const custom = { type: "_vendor_image", data: "x", extra: { a: 1 } };
  expect(zodV2.zContentBlock.parse(custom)).toEqual(custom);
  expect(decode(v2.ContentBlock, custom)).toEqual(custom);
  const malformed = { type: "text", content: "no text field" };
  expect(zodV2.zContentBlock.safeParse(malformed).success).toBe(false);
  expect(refuses(v2.ContentBlock, malformed)).toBe(true);
});

test("AS9: a uri, a date-time and a bounded integer format are checked as the SDK checks them", () => {
  for (const [line, valid] of [
    [4294967295, true],
    [4294967296, false],
    [-1, false],
    [1.5, false],
  ] as const)
    expect({ line, sdk: zodV2.zPosition.safeParse({ line, character: 0 }).success, ours: !refuses(v2.Position, { line, character: 0 }) }).toEqual({ line, sdk: valid, ours: valid });
  const link = (uri: string) => ({ name: "notes", uri });
  for (const uri of ["file:///tmp/notes.md", "https://example.com/a?b#c", "urn:isbn:0451450523", " https://example.com/ "])
    expect({ uri, sdk: zodV2.zResourceLink.safeParse(link(uri)).success, ours: !refuses(v2.ResourceLink, link(uri)) }).toEqual({ uri, sdk: true, ours: true });
  for (const uri of ["notes.md", "", "http://"])
    expect({ uri, sdk: zodV2.zResourceLink.safeParse(link(uri)).success, ours: !refuses(v2.ResourceLink, link(uri)) }).toEqual({ uri, sdk: false, ours: false });
  const info = (updatedAt: string) => ({ sessionId: "s", cwd: "/", updatedAt });
  for (const [updatedAt, valid] of [
    ["2026-10-02T10:00:00Z", true],
    ["2026-10-02T10:00:00.123+02:00", true],
    ["2026-10-02", false],
    ["2026-02-30T10:00:00Z", false],
    ["2026-10-02T10:00Z", false],
  ] as const) {
    // `updatedAt` is default-on-error, so on both sides an invalid one is dropped rather than refused.
    const sdk = zodV2.zSessionInfo.parse(info(updatedAt)).updatedAt !== undefined;
    const ours = Schema.decodeSync(v2.SessionInfo)(info(updatedAt)).updatedAt !== undefined;
    expect({ updatedAt, sdk, ours }).toEqual({ updatedAt, sdk: valid, ours: valid });
  }
});
