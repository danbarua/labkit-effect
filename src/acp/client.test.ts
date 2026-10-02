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
import { Cause, Effect, Exit, Fiber, Layer, Logger, References, Schema, type Scope, Stream } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Agent from "./agent.ts";
import * as Client from "./client.ts";
import * as Http from "./http.ts";
import { JsonRpcError, type Wire } from "./json-rpc.ts";
import { logKeys } from "./log-keys.ts";
import {
  AgentExtensions,
  type AgentWithExtensions,
  info as agentInfo,
  v1 as agentV1,
  v2 as agentV2,
  ClientExtensions,
  decode,
  textOf,
  v1WithExtensions,
} from "./negotiation-test-agent.ts";
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
        "fs/read_text_file": () => Effect.succeed({ content: "file contents" }),
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

/** The SDK's v1 agent, recording each method it receives, and each `initialize`'s params in `initialized`. Its prompt does what its text says. */
function sdkAgentV1(received: Array<string>, agentCapabilities: acp.AgentCapabilities = {}, initialized: Array<acp.InitializeRequest> = []) {
  return acp
    .agent({ name: "an-sdk-agent" })
    .onRequest("initialize", (c) => {
      received.push(`initialize ${c.params.protocolVersion}`);
      initialized.push(c.params);
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
  | Agent.AgentImplementation<Protocol.V2Version, never>
  | AgentWithExtensions;

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
  test("AN6: a client implementing versions 1 and 2 offers 1, the highest stable version, gets 1 from the SDK's v1 agent, and runs a turn with a permission request", async () => {
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
    expect(received).toEqual(["initialize 1", "session/new", "session/prompt"]);
    expect(result).toEqual({ version: 1, agentInfo: { name: "an-sdk-agent", version: "1.0.0" }, stopReason: "end_turn" });
    expect(seen).toEqual(["update: Working.", "permission", 'update: Answered: {"outcome":"selected","optionId":"allow-once"}']);
  });

  test("AN6: a client implementing versions 1 and 2 that offers the version 2 draft gets 2 from the SDK's v2 agent, and runs a version 2 turn with a permission request", async () => {
    const ends = pipes();
    sdkAgentV2().connect(acpv2.ndJsonStream(ends.agentWritable, ends.agentReadable));
    const seen: Seen = [];
    const result = await run(
      Effect.gen(function* () {
        const connection = yield* Client.connect({ wire: ends.client, info, implementations: [clientV1(seen), clientV2(seen)], offer: 2 });
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

  test("AN6: against our agent, a client implementing versions 1 and 2 gets 1 by default; offering 2, it gets 2 when the agent implements both, and 1 when it implements only 1", async () => {
    const turn = async (agent: OurAgent, offer: 1 | 2 | undefined) => {
      const seen: Seen = [];
      const version = await run(
        Effect.gen(function* () {
          const connection = yield* Client.connect({ wire: agent.wire, info, implementations: [clientV1(seen), clientV2(seen)], offer });
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
    const turned = ["update: Working.", "permission", 'update: Answered: {"outcome":"selected","optionId":"allow-once"}'];
    const byDefault = await turn(ourAgent([agentV1(), agentV2()]), undefined);
    expect(byDefault).toEqual({ version: 1, seen: turned });
    const both = await turn(ourAgent([agentV1(), agentV2()]), 2);
    expect(both).toEqual({ version: 2, seen: turned });
    const onlyV1 = await turn(ourAgent([agentV1()]), 2);
    expect(onlyV1).toEqual({ version: 1, seen: turned });
  });

  test("AN6: a client implementing only the version 2 draft offers 2, and fails with UnsupportedProtocolVersion against an agent implementing only version 1", async () => {
    const agent = ourAgent([agentV1()]);
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Client.connect({ wire: agent.wire, info, implementations: [clientV2([])] })),
    );
    await agent.stop();
    expect(exit).toEqual(Exit.fail(new Client.UnsupportedProtocolVersion({ offered: 2, answered: 1 })));
  });

  test("AN6: a client implementing versions 1 (with fs and terminal) and 2 offers 1, the highest stable version, by default, and the SDK's v1 agent receives its capabilities; offering 2, the profile's client side is what the v1 agent received, and the client's gates use it", async () => {
    const capabilities: V1.ClientCapabilities = { fs: { readTextFile: true, writeTextFile: true }, terminal: true };
    const connectTo = async (offer: 1 | 2 | undefined) => {
      const ends = pipes();
      const initialized: Array<acp.InitializeRequest> = [];
      sdkAgentV1([], {}, initialized).connect(acp.ndJsonStream(ends.agentWritable, ends.agentReadable));
      const seen: Seen = [];
      const client = await run(
        Effect.gen(function* () {
          const connection = yield* Client.connect({
            wire: ends.client,
            info,
            implementations: [clientV1(seen, capabilities), clientV2(seen)],
            offer,
          });
          if (connection.protocolVersion !== 1) return { version: connection.protocolVersion };
          const { sessionId } = yield* connection.agent["session/new"]({ cwd: "/tmp", mcpServers: [] });
          yield* connection.agent["session/prompt"]({ sessionId, prompt: [{ type: "text", text: "read" }] });
          return { version: connection.protocolVersion, profile: connection.profile.client };
        }),
      );
      return { client, initialized, seen };
    };
    const byDefault = await connectTo(undefined);
    expect(byDefault.initialized).toEqual([{ protocolVersion: 1, clientCapabilities: expect.objectContaining(capabilities), clientInfo: info }]);
    expect(byDefault.client).toEqual({ version: 1, profile: { capabilities, info } });
    expect(byDefault.seen).toEqual(["update: Working.", "update: Read: file contents"]);
    const draft = await connectTo(2);
    expect(draft.initialized).toHaveLength(1);
    expect(draft.initialized[0]?.protocolVersion).toBe(2);
    expect(draft.initialized[0]?.clientCapabilities?.fs?.readTextFile).not.toBe(true);
    expect(draft.initialized[0]?.clientCapabilities?.terminal).not.toBe(true);
    expect(draft.client).toEqual({ version: 1, profile: { capabilities: {}, info: undefined } });
    expect(draft.seen).toEqual(["update: Working.", 'update: Read: -32601 {"capability":"clientCapabilities.fs.readTextFile"}']);
  });

  test("AN6: a malformed answer to initialize fails connect with InitializeFailed", async () => {
    const ends = pipes();
    const exit = Effect.runPromiseExit(Effect.scoped(Client.connect({ wire: ends.client, info, implementations: [clientV1([])] })));
    const reader = ends.agentReadable.getReader();
    const writer = ends.agentWritable.getWriter();
    const asked = new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(asked)).toMatchObject({ id: 0, method: "initialize" });
    // An error with no message.
    await writer.write(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -32000 } })}\n`));
    const failed = await exit;
    expect(Exit.isFailure(failed) && Cause.squash(failed.cause)).toMatchObject({
      _tag: "InitializeFailed",
      reason: expect.stringContaining("malformed"),
    });
  });
});

describe("decoding over the wire", () => {
  test("AS5 AS6 AP13: the SDK's v1 agent sends the client a default-on-error field that fails to decode and a skip-invalid-items array with an invalid item; the client's call and handler get the default and the array without the item", async () => {
    const annotations = { audience: ["user", 5, "assistant"], priority: "high" };
    const ends = pipes();
    acp
      .agent({ name: "an-sdk-agent" })
      .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }))
      // `availableModes` defaults to [] on error; `audience` skips invalid items; `priority` has no
      // default and is left out.
      .onRequest("session/new", () => ({ sessionId: "sdk-session", modes: { currentModeId: "ask", availableModes: "none" } }) as never)
      .onRequest("session/prompt", async (c) => {
        const content = { type: "text", text: "hello", annotations } as unknown as acp.ContentBlock;
        await c.client.notify("session/update", { sessionId: c.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content } });
        return { stopReason: "end_turn" as const };
      })
      .connect(acp.ndJsonStream(ends.agentWritable, ends.agentReadable));
    const received: Array<unknown> = [];
    const wire: Wire = {
      read: ends.client.read.pipe(Stream.tap((input) => Effect.sync(() => input._tag === "Json" && received.push(input.value)))),
      write: ends.client.write,
    };
    const updates: Array<unknown> = [];
    const client = Client.implement(Protocol.v1, {
      capabilities: {},
      handlers: () => Effect.succeed({ "session/update": ({ update }) => Effect.sync(() => updates.push(update)) }),
    });
    const result = await run(
      Effect.gen(function* () {
        const connection = yield* Client.connect({ wire, info, implementations: [client] });
        const created = yield* connection.agent["session/new"]({ cwd: "/tmp", mcpServers: [] });
        const prompted = yield* connection.agent["session/prompt"]({ sessionId: created.sessionId, prompt: [{ type: "text", text: "go" }] });
        return { modes: created.modes, stopReason: prompted.stopReason };
      }),
    );
    // The SDK sent the values as given.
    expect(received).toContainEqual(expect.objectContaining({ result: { sessionId: "sdk-session", modes: { currentModeId: "ask", availableModes: "none" } } }));
    expect(received).toContainEqual(
      expect.objectContaining({ method: "session/update", params: expect.objectContaining({ update: expect.objectContaining({ content: { type: "text", text: "hello", annotations } }) }) }),
    );
    expect(result).toEqual({ modes: { currentModeId: V1.SessionModeId.make("ask"), availableModes: [] }, stopReason: "end_turn" });
    expect(updates).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello", annotations: { audience: ["user", "assistant"] } } },
    ]);
  });

  test("AP13: a result its method's success schema refuses fails that call with -32603 naming the method, as a failure and not a defect, and the connection goes on", async () => {
    const ends = pipes();
    let sessions = 0;
    acp
      .agent({ name: "an-sdk-agent" })
      .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }))
      // The first answer's sessionId is a number, which session/new's success schema refuses.
      .onRequest("session/new", () => (++sessions === 1 ? { sessionId: 42 } : { sessionId: "sdk-session" }) as never)
      .connect(acp.ndJsonStream(ends.agentWritable, ends.agentReadable));
    const { refused, after } = await run(
      Effect.gen(function* () {
        const connection = yield* Client.connect({ wire: ends.client, info, implementations: [clientV1([])] });
        const refused = yield* Effect.exit(connection.agent["session/new"]({ cwd: "/tmp", mcpServers: [] }));
        const after = yield* connection.agent["session/new"]({ cwd: "/tmp", mcpServers: [] });
        return { refused, after };
      }),
    );
    expect(Exit.isFailure(refused) && refused.cause.reasons.map((reason) => reason._tag)).toEqual(["Fail"]);
    expect(Exit.isFailure(refused) && Cause.squash(refused.cause)).toEqual({
      code: -32603,
      message: "The result does not match session/new's schema",
      data: { result: { sessionId: 42 }, issue: expect.any(String) },
    });
    expect(after).toEqual({ sessionId: V1.SessionId.make("sdk-session") });
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
      expect(received).toEqual(["initialize 1", "session/new", "session/prompt"]);
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
      Effect.scoped(Client.connect({ wire: agent.wire, info, implementations: [clientV1([]), clientV2([])], offer: 2 })).pipe(
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

describe("extension methods", () => {
  // The client calls `_an/echo` and `_an/unknown`, which the agent does not serve, and sends `_an/ping`.
  const clientCalls = AgentExtensions.omit("_an/ping").add(
    Rpc.make("_an/unknown", { payload: {}, success: Schema.Struct({}), error: JsonRpcError }),
  );
  const clientNotifications = AgentExtensions.omit("_an/echo");

  /** A version 1 client with extension methods only; what its handlers see goes to `seen`. */
  const clientWithExtensions = (seen: Seen) =>
    Client.implement(
      Protocol.v1,
      { serve: ClientExtensions, call: clientCalls, notify: clientNotifications },
      {
        capabilities: {},
        handlers: () =>
          Effect.succeed({
            "_an/ask": ({ question }) =>
              Effect.sync(() => {
                seen.push(`ask: ${question}`);
                return { answer: "yes" };
              }),
            "_an/progress": ({ note }) =>
              Effect.sync(() => {
                seen.push(`progress: ${note}`);
              }),
          }),
      },
    );

  test("AN13: an Effect agent and an Effect client call and notify each other's extension methods, and an extension method the other end does not serve is -32601", async () => {
    const pinged: Array<string> = [];
    const agent = ourAgent([v1WithExtensions(pinged)]);
    const seen: Seen = [];
    const result = await run(
      Effect.gen(function* () {
        const connection = yield* Client.connect({ wire: agent.wire, info, implementations: [clientWithExtensions(seen)] });
        yield* connection.extensions.notify("_an/ping", { note: "hello" });
        const echoed = yield* connection.extensions.call["_an/echo"]({ text: "ready?" });
        const unknown = yield* connection.extensions.call["_an/unknown"]({}).pipe(Effect.flip);
        return { echoed, unknown };
      }),
    );
    await agent.stop();
    expect(result).toEqual({ echoed: { text: "ready?: yes" }, unknown: { code: -32601, message: "Method not found: _an/unknown" } });
    expect(seen).toEqual(["progress: echoing ready?", "ask: ready?"]);
    expect(pinged).toEqual(["hello"]);
  });

  test("AN13: implement throws when an extension method's name does not start with _", () => {
    const named = RpcGroup.make(Rpc.make("an/echo", { payload: { text: Schema.String } }));
    expect(() => Client.implement(Protocol.v1, { notify: named }, { capabilities: {}, handlers: () => Effect.succeed({}) })).toThrow(
      '"an/echo" is declared as an extension method',
    );
    expect(() => Agent.implement(Protocol.v2, { serve: named }, { capabilities: {}, handlers: () => Effect.succeed({}) })).toThrow(
      '"an/echo" is declared as an extension method',
    );
  });
});
