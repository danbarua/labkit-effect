/**
 * `protocol.ts`: the version an agent chooses, and each version's capability gates, every gate
 * refused under a profile that advertises nothing and let through under one that advertises it.
 * The SDK cannot provoke most of these (it checks no capability), so the gates are called directly;
 * `agent.test.ts` and `client.test.ts` show them on the wire.
 */

import { describe, expect, test } from "bun:test";
import { decode } from "./negotiation-test-agent.ts";
import * as Protocol from "./protocol.ts";
import * as V1 from "./schema/v1.gen.ts";
import * as V2 from "./schema/v2.gen.ts";

describe("select", () => {
  test("AN1: the offered version when it is supported, otherwise the highest supported", () => {
    expect(Protocol.select([1, 2], 1)).toBe(1);
    expect(Protocol.select([1, 2], 2)).toBe(2);
    expect(Protocol.select([1, 2], 3)).toBe(2);
    expect(Protocol.select([1], 2)).toBe(1);
    expect(Protocol.select([2], 1)).toBe(2);
    expect(Protocol.select([1, 2], 0)).toBe(2);
  });
});

interface Case {
  readonly direction: Protocol.Direction;
  readonly method: string;
  readonly params: unknown;
  readonly capability: string;
  readonly needs: "method" | "params";
}

const v1Profile = (agent: unknown, client: unknown, authMethods: unknown = []): Protocol.Profile<Protocol.V1Version> => ({
  protocolVersion: 1,
  client: { capabilities: decode(V1.ClientCapabilities, client), info: undefined },
  agent: {
    capabilities: decode(V1.AgentCapabilities, agent),
    info: undefined,
    authMethods: decode(V1.InitializeResponse, { protocolVersion: 1, authMethods }).authMethods ?? [],
  },
});

const v2Profile = (agent: unknown, client: unknown, authMethods: unknown = []): Protocol.Profile<Protocol.V2Version> => ({
  protocolVersion: 2,
  client: { capabilities: decode(V2.ClientCapabilities, client), info: undefined },
  agent: {
    capabilities: decode(V2.AgentCapabilities, agent),
    info: undefined,
    authMethods: decode(V2.InitializeResponse, { protocolVersion: 2, info: { name: "a", version: "1" }, authMethods }).authMethods ?? [],
  },
});

const toAgent = (method: string, params: unknown, capability: string, needs: Case["needs"] = "method"): Case => ({
  direction: "toAgent",
  method,
  params,
  capability,
  needs,
});

const toClient = (method: string, params: unknown, capability: string, needs: Case["needs"] = "method"): Case => ({
  direction: "toClient",
  method,
  params,
  capability,
  needs,
});

const prompt = (type: string) => ({ sessionId: "s", prompt: [{ type: "text", text: "hi" }, { type }] });

const update = (update: unknown) => ({ sessionId: "s", update });

const v1Cases: ReadonlyArray<Case> = [
  toAgent("session/load", {}, "agentCapabilities.loadSession"),
  ...["resume", "close", "list", "delete", "fork"].map((method) =>
    toAgent(`session/${method}`, {}, `agentCapabilities.sessionCapabilities.${method}`),
  ),
  toAgent("logout", {}, "agentCapabilities.auth.logout"),
  toAgent("mcp/message", {}, "agentCapabilities.mcpCapabilities.acp"),
  toAgent("providers/list", {}, "agentCapabilities.providers"),
  toAgent("nes/start", {}, "agentCapabilities.nes"),
  toAgent("nes/accept", {}, "agentCapabilities.nes"),
  ...["didOpen", "didChange", "didClose", "didSave", "didFocus"].map((event) =>
    toAgent(`document/${event}`, {}, `agentCapabilities.nes.events.document.${event}`),
  ),
  toAgent("authenticate", { methodId: "agent-login" }, "authMethods", "params"),
  toAgent("session/prompt", prompt("image"), "agentCapabilities.promptCapabilities.image", "params"),
  toAgent("session/prompt", prompt("audio"), "agentCapabilities.promptCapabilities.audio", "params"),
  toAgent("session/prompt", prompt("resource"), "agentCapabilities.promptCapabilities.embeddedContext", "params"),
  ...["session/new", "session/load", "session/resume", "session/fork"].flatMap((method) => [
    toAgent(method, { additionalDirectories: ["/var"] }, "agentCapabilities.sessionCapabilities.additionalDirectories", "params"),
    toAgent(method, { mcpServers: [{ type: "http" }] }, "agentCapabilities.mcpCapabilities.http", "params"),
    toAgent(method, { mcpServers: [{ type: "sse" }] }, "agentCapabilities.mcpCapabilities.sse", "params"),
    toAgent(method, { mcpServers: [{ type: "acp" }] }, "agentCapabilities.mcpCapabilities.acp", "params"),
  ]),
  toClient("fs/read_text_file", {}, "clientCapabilities.fs.readTextFile"),
  toClient("fs/write_text_file", {}, "clientCapabilities.fs.writeTextFile"),
  ...["create", "output", "release", "wait_for_exit", "kill"].map((method) =>
    toClient(`terminal/${method}`, {}, "clientCapabilities.terminal"),
  ),
  toClient("elicitation/complete", {}, "clientCapabilities.elicitation.url"),
  toClient("mcp/connect", {}, "agentCapabilities.mcpCapabilities.acp"),
  toClient("mcp/message", {}, "agentCapabilities.mcpCapabilities.acp"),
  toClient("mcp/disconnect", {}, "agentCapabilities.mcpCapabilities.acp"),
  toClient("elicitation/create", { mode: "form" }, "clientCapabilities.elicitation.form", "params"),
  toClient("elicitation/create", { mode: "url" }, "clientCapabilities.elicitation.url", "params"),
  toClient("session/update", update({ sessionUpdate: "plan_update" }), "clientCapabilities.plan", "params"),
  toClient("session/update", update({ sessionUpdate: "plan_removed" }), "clientCapabilities.plan", "params"),
  toClient("session/update", update({ sessionUpdate: "notice" }), "clientCapabilities.session.notices", "params"),
  toClient("session/update", update({ sessionUpdate: "compaction_update" }), "clientCapabilities.session.compaction", "params"),
  toClient(
    "session/update",
    update({ sessionUpdate: "compaction_summary_chunk" }),
    "clientCapabilities.session.compaction",
    "params",
  ),
  toClient(
    "session/update",
    update({ sessionUpdate: "config_option_update", configOptions: [{ type: "select" }, { type: "boolean" }] }),
    "clientCapabilities.session.configOptions.boolean",
    "params",
  ),
];

const v1Nothing = v1Profile({}, {});

// The params of `session/load`, `session/resume` and `session/fork` are checked once the method is let through.
const v1MethodsOnly = v1Profile({ loadSession: true, sessionCapabilities: { resume: {}, fork: {} } }, {});

const v1Everything = v1Profile(
  {
    loadSession: true,
    promptCapabilities: { image: true, audio: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true, acp: true },
    sessionCapabilities: { list: {}, delete: {}, additionalDirectories: {}, fork: {}, resume: {}, close: {} },
    auth: { logout: {} },
    providers: {},
    nes: { events: { document: { didOpen: {}, didChange: { syncKind: "full" }, didClose: {}, didSave: {}, didFocus: {} } } },
  },
  {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
    plan: {},
    elicitation: { form: {}, url: {} },
    session: { notices: {}, compaction: {}, configOptions: { boolean: {} } },
  },
  [
    { id: "agent-login", name: "Login" },
    { type: "terminal", id: "terminal-login", name: "Log in in a terminal" },
  ],
);

const v2Cases: ReadonlyArray<Case> = [
  toAgent("session/delete", {}, "capabilities.session.delete"),
  toAgent("session/fork", {}, "capabilities.session.fork"),
  toAgent("auth/login", { methodId: "agent-login" }, "authMethods"),
  toAgent("auth/logout", {}, "authMethods"),
  toAgent("mcp/message", {}, "capabilities.session.mcp.acp"),
  toAgent("providers/set", {}, "capabilities.providers"),
  toAgent("nes/suggest", {}, "capabilities.nes"),
  ...["didOpen", "didChange", "didClose", "didSave", "didFocus"].map((event) =>
    toAgent(`document/${event}`, {}, `capabilities.nes.events.document.${event}`),
  ),
  toAgent("session/prompt", prompt("image"), "capabilities.session.prompt.image", "params"),
  toAgent("session/prompt", prompt("audio"), "capabilities.session.prompt.audio", "params"),
  toAgent("session/prompt", prompt("resource"), "capabilities.session.prompt.embeddedContext", "params"),
  ...["session/new", "session/resume", "session/fork"].flatMap((method) => [
    toAgent(method, { additionalDirectories: ["/var"] }, "capabilities.session.additionalDirectories", "params"),
    toAgent(method, { mcpServers: [{ type: "stdio" }] }, "capabilities.session.mcp.stdio", "params"),
    toAgent(method, { mcpServers: [{ type: "http" }] }, "capabilities.session.mcp.http", "params"),
    toAgent(method, { mcpServers: [{ type: "acp" }] }, "capabilities.session.mcp.acp", "params"),
  ]),
  toClient("elicitation/complete", {}, "capabilities.elicitation.url"),
  toClient("mcp/connect", {}, "capabilities.session.mcp.acp"),
  toClient("elicitation/create", { mode: "form" }, "capabilities.elicitation.form", "params"),
  toClient("elicitation/create", { mode: "url" }, "capabilities.elicitation.url", "params"),
];

// Version 2's session methods all need `capabilities.session`; this profile has it, and nothing else.
const v2SessionOnly = v2Profile({ session: {} }, {});

const v2MethodsOnly = v2Profile({ session: { fork: {} } }, {});

const v2Everything = v2Profile(
  {
    session: {
      prompt: { image: {}, audio: {}, embeddedContext: {} },
      mcp: { stdio: {}, http: {}, acp: {} },
      delete: {},
      additionalDirectories: {},
      fork: {},
    },
    providers: {},
    nes: { events: { document: { didOpen: {}, didChange: { syncKind: "full" }, didClose: {}, didSave: {}, didFocus: {} } } },
  },
  { elicitation: { form: {}, url: {} } },
  [
    { type: "agent", methodId: "agent-login", name: "Login" },
    { type: "terminal", methodId: "terminal-login", name: "Log in in a terminal" },
  ],
);

const refusal = (gate: Protocol.Gate) =>
  gate._tag === "Refused" ? { capability: gate.capability, needs: gate.needs } : { allowed: true };

describe("version 1's gates", () => {
  test.each(v1Cases.map((c) => [c.direction, c.method, JSON.stringify(c.params), c] as const))(
    "AN10: %s %s %s is refused naming its capability when it is not advertised, and let through when it is",
    (_direction, _method, _params, c) => {
      const base = c.needs === "params" ? v1MethodsOnly : v1Nothing;
      expect(refusal(Protocol.v1.gate(c.direction, c.method, c.params, base))).toEqual({
        capability: c.capability,
        needs: c.needs,
      });
      expect(Protocol.v1.gate(c.direction, c.method, c.params, v1Everything)).toEqual({ _tag: "Allowed" });
    },
  );

  test("AN10: authenticate with a terminal auth method, or one the agent did not advertise, is refused even when others are advertised", () => {
    expect(refusal(Protocol.v1.gate("toAgent", "authenticate", { methodId: "terminal-login" }, v1Everything))).toEqual({
      capability: "authMethods",
      needs: "params",
    });
    expect(refusal(Protocol.v1.gate("toAgent", "authenticate", { methodId: "other" }, v1Everything))).toEqual({
      capability: "authMethods",
      needs: "params",
    });
  });

  test("AN10: what needs no capability is let through under a profile that advertises nothing", () => {
    const allowed: ReadonlyArray<readonly [Protocol.Direction, string, unknown]> = [
      ["toAgent", "session/new", { cwd: "/tmp", mcpServers: [{ name: "local", command: "mcp" }], additionalDirectories: [] }],
      ["toAgent", "session/prompt", { sessionId: "s", prompt: [{ type: "text" }, { type: "resource_link" }] }],
      ["toAgent", "session/cancel", { sessionId: "s" }],
      ["toAgent", "session/set_mode", {}],
      ["toClient", "session/request_permission", {}],
      ["toClient", "session/update", update({ sessionUpdate: "agent_message_chunk" })],
      ["toClient", "session/update", update({ sessionUpdate: "plan" })],
      ["toClient", "session/update", update({ sessionUpdate: "config_option_update", configOptions: [{ type: "select" }] })],
      ["toClient", "elicitation/create", { mode: "_custom" }],
    ];
    for (const [direction, method, params] of allowed)
      expect(Protocol.v1.gate(direction, method, params, v1Nothing)).toEqual({ _tag: "Allowed" });
  });
});

describe("version 2's gates", () => {
  test.each(v2Cases.map((c) => [c.direction, c.method, JSON.stringify(c.params), c] as const))(
    "AN11: %s %s %s is refused naming its capability when it is not advertised, and let through when it is",
    (_direction, _method, _params, c) => {
      const base = c.needs === "params" ? v2MethodsOnly : v2SessionOnly;
      expect(refusal(Protocol.v2.gate(c.direction, c.method, c.params, base))).toEqual({
        capability: c.capability,
        needs: c.needs,
      });
      expect(Protocol.v2.gate(c.direction, c.method, c.params, v2Everything)).toEqual({ _tag: "Allowed" });
    },
  );

  test("AN11: every session method needs capabilities.session, and auth/login a methodId the agent advertised that is not of type terminal", () => {
    const nothing = v2Profile({}, {});
    for (const method of ["new", "prompt", "cancel", "list", "resume", "close", "set_config_option", "delete", "fork"])
      expect(refusal(Protocol.v2.gate("toAgent", `session/${method}`, {}, nothing))).toEqual({
        capability: "capabilities.session",
        needs: "method",
      });
    expect(refusal(Protocol.v2.gate("toAgent", "auth/login", { methodId: "terminal-login" }, v2Everything))).toEqual({
      capability: "authMethods",
      needs: "params",
    });
  });

  test("AN11: what needs no capability is let through, a notice update included", () => {
    const allowed: ReadonlyArray<readonly [Protocol.Direction, string, unknown]> = [
      ["toAgent", "session/new", { cwd: "/tmp" }],
      ["toAgent", "session/prompt", { sessionId: "s", prompt: [{ type: "text" }, { type: "resource_link" }] }],
      ["toClient", "session/request_permission", {}],
      ["toClient", "session/update", update({ sessionUpdate: "notice" })],
      ["toClient", "session/update", update({ sessionUpdate: "plan_update" })],
      ["toClient", "elicitation/create", { mode: "_custom" }],
    ];
    for (const [direction, method, params] of allowed)
      expect(Protocol.v2.gate(direction, method, params, v2SessionOnly)).toEqual({ _tag: "Allowed" });
  });
});
