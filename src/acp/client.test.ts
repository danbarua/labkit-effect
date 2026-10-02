/**
 * `client.ts`, implementing versions 1 and 2, against the official ACP SDK's v1 agent
 * (`@agentclientprotocol/sdk`) and its draft v2 agent (`experimental/v2`), against the agent of
 * `agent.ts`, and over Streamable HTTP against the SDK's `AcpServer`.
 */

import { describe, expect, test } from "bun:test";
import http from "node:http";
import * as acp from "@agentclientprotocol/sdk";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import * as acpv2 from "@agentclientprotocol/sdk/experimental/v2";
import { Effect, Exit, Fiber, Layer, Logger, References, type Scope } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Agent from "./agent.ts";
import * as Client from "./client.ts";
import * as Http from "./http.ts";
import type { Wire } from "./json-rpc.ts";
import { logKeys } from "./log-keys.ts";
import { decode, info as agentInfo, v1 as agentV1, v2 as agentV2, textOf } from "./negotiation-test-agent.ts";
import * as Protocol from "./protocol.ts";
import * as V1 from "./schema/v1.gen.ts";
import * as V2 from "./schema/v2.gen.ts";
import { fromWebStreams } from "./stdio.ts";

const info = { name: "an-client", version: "1.0.0" };

/** What the client's handlers saw: each update's text, each request's method. */
type Seen = Array<string>;

const clientV1 = (seen: Seen, capabilities: V1.ClientCapabilities = {}) =>
  Client.implement(Protocol.v1, {
    capabilities,
    handlers: () =>
      Effect.succeed({
        "session/request_permission": () =>
          Effect.sync(() => {
            seen.push("permission");
            return decode(V1.RequestPermissionResponse, { outcome: { outcome: "selected", optionId: "allow-once" } });
          }),
        "session/update": ({ update }) => Effect.sync(() => seen.push(`update: ${textOf(update)}`)),
        "elicitation/create": () => Effect.succeed(decode(V1.CreateElicitationResponse, { action: "decline" })),
      }),
  });

const clientV2 = (seen: Seen) =>
  Client.implement(Protocol.v2, {
    capabilities: {},
    handlers: () =>
      Effect.succeed({
        "session/request_permission": () =>
          Effect.sync(() => {
            seen.push("permission");
            return decode(V2.RequestPermissionResponse, { outcome: { outcome: "selected", optionId: "allow-once" } });
          }),
        "session/update": ({ update }) => Effect.sync(() => seen.push(`update: ${textOf(update)}`)),
      }),
  });

const permissionParams = (sessionId: string): acp.RequestPermissionRequest => ({
  sessionId,
  toolCall: { toolCallId: "call-1", title: "Write a file" },
  options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
});

const say = (sessionId: string, text: string): acp.SessionNotification => ({
  sessionId,
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});

const errorText = (error: unknown): string =>
  error instanceof acp.RequestError ? `${error.code} ${JSON.stringify(error.data)}` : String(error);

/** The SDK's v1 agent, recording each method it receives. Its prompt does what its text says. */
function sdkAgentV1(received: Array<string>, agentCapabilities: acp.AgentCapabilities = {}) {
  return acp
    .agent({ name: "an-sdk-agent" })
    .onRequest("initialize", (c) => {
      received.push(`initialize ${c.params.protocolVersion}`);
      return { protocolVersion: 1, agentCapabilities, agentInfo: { name: "an-sdk-agent", version: "1.0.0" }, authMethods: [] };
    })
    .onRequest("session/new", () => {
      received.push("session/new");
      return { sessionId: "sdk-session" };
    })
    .onRequest("session/load", () => {
      received.push("session/load");
      return {};
    })
    .onRequest("session/prompt", async (c) => {
      received.push("session/prompt");
      const first = c.params.prompt[0];
      const text = first?.type === "text" ? first.text : "";
      await c.client.notify("session/update", say(c.params.sessionId, "Working."));
      if (text === "permission") {
        const answer = await c.client.request("session/request_permission", permissionParams(c.params.sessionId));
        await c.client.notify("session/update", say(c.params.sessionId, `Answered: ${JSON.stringify(answer.outcome)}`));
      }
      if (text === "elicit") {
        const answer = await c.client
          .request("elicitation/create", {
            sessionId: c.params.sessionId,
            mode: "form",
            message: "Your name?",
            requestedSchema: { type: "object", properties: {} },
          })
          .then((response) => JSON.stringify(response), errorText);
        await c.client.notify("session/update", say(c.params.sessionId, `Elicit: ${answer}`));
      }
      if (text === "read") {
        const answer = await c.client
          .request("fs/read_text_file", { sessionId: c.params.sessionId, path: "/tmp/an.txt" })
          .then((response) => response.content, errorText);
        await c.client.notify("session/update", say(c.params.sessionId, `Read: ${answer}`));
      }
      return { stopReason: "end_turn" as const };
    })
    .onNotification("session/cancel", () => undefined);
}

/** The SDK's draft v2 agent: a prompt sends an update and asks permission. */
function sdkAgentV2() {
  return acpv2
    .agent({ name: "an-sdk-agent-v2" })
    .onRequest("initialize", () => ({
      protocolVersion: 2,
      info: { name: "an-sdk-agent-v2", version: "1.0.0" },
      capabilities: { session: {} },
    }))
    .onRequest("session/new", () => ({ sessionId: "sdk-session" }))
    .onRequest("session/prompt", async (c) => {
      const update = (text: string) =>
        c.client.notify("session/update", {
          sessionId: c.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text } },
        });
      await update("Working.");
      const answer = await c.client.request("session/request_permission", {
        sessionId: c.params.sessionId,
        title: "Write a file",
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      });
      await update(`Answered: ${JSON.stringify(answer.outcome)}`);
      return { messageId: "m1" };
    })
    .onNotification("session/cancel", () => undefined);
}

/** A pair of wires in this process: the client's, and the other end's streams. */
function pipes() {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  return {
    client: fromWebStreams(toClient.readable, toAgent.writable),
    agentReadable: toAgent.readable,
    agentWritable: toClient.writable,
  };
}

type AgentImplementation =
  | Agent.AgentImplementation<Protocol.V1Version, never>
  | Agent.AgentImplementation<Protocol.V2Version, never>;

/** The agent of `agent.ts` running in this process, on the other end of `wire`. */
interface OurAgent {
  /** The client's wire to it. */
  readonly wire: Wire;
  readonly stop: () => Promise<unknown>;
}

function ourAgent(implementations: readonly [AgentImplementation, ...Array<AgentImplementation>]): OurAgent {
  const ends = pipes();
  const fiber = Effect.runFork(
    Agent.run({ wire: fromWebStreams(ends.agentReadable, ends.agentWritable), info: agentInfo, implementations }).pipe(
      Effect.provide(Logger.layer([])),
    ),
  );
  return { wire: ends.client, stop: () => Effect.runPromise(Fiber.interrupt(fiber)) };
}

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | HttpClient.HttpClient>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(Layer.merge(FetchHttpClient.layer, Logger.layer([])))));

describe("the client negotiates the version", () => {
  test("AN6: a client implementing versions 1 and 2 offers 2, gets 1 from the SDK's v1 agent, and runs a turn with a permission request", async () => {
    const ends = pipes();
    const received: Array<string> = [];
    sdkAgentV1(received).connect(acp.ndJsonStream(ends.agentWritable, ends.agentReadable));
    const seen: Seen = [];
    const result = await run(
      Effect.gen(function* () {
        const connection = yield* Client.connect({ wire: ends.client, info, implementations: [clientV1(seen), clientV2(seen)] });
        if (connection.protocolVersion !== 1) return { version: connection.protocolVersion };
        const { sessionId } = yield* connection.agent["session/new"]({ cwd: "/tmp", mcpServers: [] });
        const prompted = yield* connection.agent["session/prompt"]({ sessionId, prompt: [{ type: "text", text: "permission" }] });
        return { version: connection.protocolVersion, agentInfo: connection.profile.agent.info, stopReason: prompted.stopReason };
      }),
    );
    expect(received).toEqual(["initialize 2", "session/new", "session/prompt"]);
    expect(result).toEqual({ version: 1, agentInfo: { name: "an-sdk-agent", version: "1.0.0" }, stopReason: "end_turn" });
    expect(seen).toEqual(["update: Working.", "permission", 'update: Answered: {"outcome":"selected","optionId":"allow-once"}']);
  });

  test("AN6: a client implementing versions 1 and 2 gets 2 from the SDK's v2 agent, and runs a version 2 turn with a permission request", async () => {
    const ends = pipes();
    sdkAgentV2().connect(acpv2.ndJsonStream(ends.agentWritable, ends.agentReadable));
    const seen: Seen = [];
    const result = await run(
      Effect.gen(function* () {
        const connection = yield* Client.connect({ wire: ends.client, info, implementations: [clientV1(seen), clientV2(seen)] });
        if (connection.protocolVersion !== 2) return { version: connection.protocolVersion };
        const { sessionId } = yield* connection.agent["session/new"]({ cwd: V2.AbsolutePath.make("/tmp") });
        const prompted = yield* connection.agent["session/prompt"]({ sessionId, prompt: [{ type: "text", text: "permission" }] });
        return { version: connection.protocolVersion, messageId: prompted.messageId };
      }),
    );
    expect(result).toEqual({ version: 2, messageId: V2.MessageId.make("m1") });
    // The SDK's v2 agent reports the answer as its schema parsed it, with `optionId` first.
    expect(seen).toEqual(["update: Working.", "permission", 'update: Answered: {"optionId":"allow-once","outcome":"selected"}']);
  });

  test("AN6: against our agent, a client implementing versions 1 and 2 gets 2 when the agent implements both, and 1 when it implements only 1", async () => {
    const turn = async (agent: OurAgent) => {
      const seen: Seen = [];
      const version = await run(
        Effect.gen(function* () {
          const connection = yield* Client.connect({ wire: agent.wire, info, implementations: [clientV1(seen), clientV2(seen)] });
          if (connection.protocolVersion === 1) {
            const { sessionId } = yield* connection.agent["session/new"]({ cwd: "/tmp", mcpServers: [] });
            yield* connection.agent["session/prompt"]({ sessionId, prompt: [{ type: "text", text: "permission" }] });
          } else {
            const { sessionId } = yield* connection.agent["session/new"]({ cwd: V2.AbsolutePath.make("/tmp") });
            yield* connection.agent["session/prompt"]({ sessionId, prompt: [{ type: "text", text: "permission" }] });
          }
          return connection.protocolVersion;
        }),
      );
      await agent.stop();
      return { version, seen };
    };
    const both = await turn(ourAgent([agentV1(), agentV2()]));
    expect(both.version).toBe(2);
    expect(both.seen).toEqual(["update: Working.", "permission", 'update: Answered: {"outcome":"selected","optionId":"allow-once"}']);
    const onlyV1 = await turn(ourAgent([agentV1()]));
    expect(onlyV1.version).toBe(1);
    expect(onlyV1.seen).toEqual(["update: Working.", "permission", 'update: Answered: {"outcome":"selected","optionId":"allow-once"}']);
  });

  test("AN6: a client implementing only version 2 fails with UnsupportedProtocolVersion against an agent implementing only version 1", async () => {
    const agent = ourAgent([agentV1()]);
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Client.connect({ wire: agent.wire, info, implementations: [clientV2([])] })),
    );
    await agent.stop();
    expect(exit).toEqual(Exit.fail(new Client.UnsupportedProtocolVersion({ offered: 2, answered: 1 })));
  });
});

describe("the client's gates", () => {
  const withSdkAgent = async <A, E>(
    capabilities: { readonly client?: V1.ClientCapabilities; readonly agent?: acp.AgentCapabilities },
    body: (connection: Client.ClientConnection<Protocol.V1Version>, sessionId: V1.SessionId) => Effect.Effect<A, E>,
  ) => {
    const ends = pipes();
    const received: Array<string> = [];
    sdkAgentV1(received, capabilities.agent).connect(acp.ndJsonStream(ends.agentWritable, ends.agentReadable));
    const seen: Seen = [];
    const result = await run(
      Effect.gen(function* () {
        const connection = yield* Client.connect({ wire: ends.client, info, implementations: [clientV1(seen, capabilities.client)] });
        const { sessionId } = yield* connection.agent["session/new"]({ cwd: "/tmp", mcpServers: [] });
        return yield* body(connection, sessionId);
      }),
    );
    return { result, received, seen };
  };

  test("AN7: an elicitation in a mode the client did not advertise is answered -32602 naming the capability, and fs/read_text_file without fs -32601", async () => {
    const { seen } = await withSdkAgent({ client: { elicitation: {} } }, (connection, sessionId) =>
      Effect.gen(function* () {
        yield* connection.agent["session/prompt"]({ sessionId, prompt: [{ type: "text", text: "elicit" }] });
        yield* connection.agent["session/prompt"]({ sessionId, prompt: [{ type: "text", text: "read" }] });
      }),
    );
    expect(seen).toEqual([
      "update: Working.",
      'update: Elicit: -32602 {"capability":"clientCapabilities.elicitation.form"}',
      "update: Working.",
      'update: Read: -32601 {"capability":"clientCapabilities.fs.readTextFile"}',
    ]);
  });

  test("AN7: an elicitation in a mode the client advertised reaches its handler", async () => {
    const { seen } = await withSdkAgent({ client: { elicitation: { form: {} } } }, (connection, sessionId) =>
      connection.agent["session/prompt"]({ sessionId, prompt: [{ type: "text", text: "elicit" }] }),
    );
    expect(seen).toEqual(["update: Working.", 'update: Elicit: {"action":"decline"}']);
  });

  test("AN5: the client's session/load is refused with CapabilityNotAdvertised and not sent when the agent did not advertise loadSession, and sent when it did", async () => {
    const refused = await withSdkAgent({}, (connection, sessionId) =>
      connection.agent["session/load"]({ sessionId, cwd: "/tmp", mcpServers: [] }).pipe(Effect.flip),
    );
    expect(refused.result).toMatchObject({
      _tag: "CapabilityNotAdvertised",
      method: "session/load",
      capability: "agentCapabilities.loadSession",
    });
    expect(refused.received).not.toContain("session/load");
    const sent = await withSdkAgent({ agent: { loadSession: true } }, (connection, sessionId) =>
      connection.agent["session/load"]({ sessionId, cwd: "/tmp", mcpServers: [] }),
    );
    expect(sent.received).toContain("session/load");
  });
});

describe("the client over Streamable HTTP", () => {
  test("AN8: connect over http.connect to the SDK's AcpServer: initialize, session/new and a prompt with a permission request", async () => {
    const received: Array<string> = [];
    const acpServer = new AcpServer({ createAgent: () => sdkAgentV1(received) });
    const server = http.createServer(createNodeHttpHandler(acpServer));
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/acp`;
    try {
      const seen: Seen = [];
      const result = await run(
        Effect.gen(function* () {
          const wire: Wire = yield* Http.connect(url);
          const connection = yield* Client.connect({ wire, info, implementations: [clientV1(seen), clientV2(seen)] });
          if (connection.protocolVersion !== 1) return { version: connection.protocolVersion };
          const { sessionId } = yield* connection.agent["session/new"]({ cwd: "/tmp", mcpServers: [] });
          const prompted = yield* connection.agent["session/prompt"]({ sessionId, prompt: [{ type: "text", text: "permission" }] });
          return { version: connection.protocolVersion, stopReason: prompted.stopReason };
        }),
      );
      expect(result).toEqual({ version: 1, stopReason: "end_turn" });
      expect(received).toEqual(["initialize 2", "session/new", "session/prompt"]);
      expect(seen).toEqual(["update: Working.", "permission", 'update: Answered: {"outcome":"selected","optionId":"allow-once"}']);
    } finally {
      await acpServer.close();
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
  });
});

describe("the client's logs", () => {
  test("AN9: the client logs the version it offered and the version the agent chose, at Info", async () => {
    const agent = ourAgent([agentV1()]);
    const logged: Array<{ readonly level: string; readonly message: unknown }> = [];
    await Effect.runPromise(
      Effect.scoped(Client.connect({ wire: agent.wire, info, implementations: [clientV1([]), clientV2([])] })).pipe(
        Effect.provide(Logger.layer([Logger.make((options) => logged.push({ level: options.logLevel, message: options.message }))])),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      ),
    );
    await agent.stop();
    expect(logged).toEqual([
      { level: "Info", message: [logKeys.initialize.negotiated, { side: "client", offered: 2, chosen: 1 }] },
    ]);
  });
});
