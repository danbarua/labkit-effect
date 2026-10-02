/**
 * `agent.ts`, as the agent in `negotiation-test-agent.ts`, driven by the official ACP SDK's v1
 * client (`@agentclientprotocol/sdk`) and its draft v2 client (`experimental/v2`), in this process,
 * over a stdio subprocess and over Streamable HTTP. What the SDK cannot provoke is written as raw
 * JSON-RPC.
 */

import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import * as acpv2 from "@agentclientprotocol/sdk/experimental/v2";
import { Deferred, Effect, Fiber, Layer, Logger, References, Scope, Stream } from "effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Agent from "./agent.ts";
import type { JsonRpcMessage, Wire } from "./json-rpc.ts";
import { logKeys } from "./log-keys.ts";
import { type AgentWithExtensions, decode, info, textOf, v1, v1WithExtensions, v2 } from "./negotiation-test-agent.ts";
import * as Protocol from "./protocol.ts";
import * as V1 from "./schema/v1.gen.ts";
import * as V2 from "./schema/v2.gen.ts";
import { fromWebStreams } from "./stdio.ts";

const encoder = new TextEncoder();

interface Logged {
  readonly level: string;
  readonly message: unknown;
}

/** The implementations these tests run: none needs a service. */
type Implementations = readonly [Implementation, ...Array<Implementation>];

type Implementation =
  | Agent.AgentImplementation<Protocol.V1Version, never>
  | Agent.AgentImplementation<Protocol.V1Version, Scope.Scope>
  | Agent.AgentImplementation<Protocol.V2Version, never>
  | AgentWithExtensions;

/** The agent running in this process, and what the tests see of it. */
interface Started {
  /** What the client writes to the agent. */
  readonly input: WritableStream<Uint8Array>;
  /** What the agent writes to the client. */
  readonly output: ReadableStream<Uint8Array>;
  /** Every message the agent wrote. */
  readonly sent: ReadonlyArray<JsonRpcMessage | ReadonlyArray<JsonRpcMessage>>;
  /** Every JSON value the agent read, as it arrived. */
  readonly received: ReadonlyArray<unknown>;
  /** Every log line, Debug included. */
  readonly logged: ReadonlyArray<Logged>;
  /** Completes when `Agent.run` returns. */
  readonly ended: Promise<unknown>;
  readonly stop: () => Promise<unknown>;
}

/** `Agent.run` in this process on a pair of `TransformStream`s. */
function start(implementations: Implementations): Started {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const wire = fromWebStreams(toAgent.readable, toClient.writable);
  const sent: Array<JsonRpcMessage | ReadonlyArray<JsonRpcMessage>> = [];
  const received: Array<unknown> = [];
  const logged: Array<Logged> = [];
  const recorded: Wire = {
    read: wire.read.pipe(Stream.tap((input) => Effect.sync(() => input._tag === "Json" && received.push(input.value)))),
    write: (message) => Effect.suspend(() => (sent.push(message), wire.write(message))),
  };
  const fiber = Effect.runFork(
    Agent.run({ wire: recorded, info, implementations }).pipe(
      Effect.provide(Logger.layer([Logger.make((options) => logged.push({ level: options.logLevel, message: options.message }))])),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
    ),
  );
  return {
    input: toAgent.writable,
    output: toClient.readable,
    sent,
    received,
    logged,
    ended: Effect.runPromise(Fiber.await(fiber)),
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
  };
}

/** A client that writes raw JSON-RPC to the agent and reads back what it writes, one line at a time. */
function raw(agent: Started) {
  const writer = agent.input.getWriter();
  const reader = agent.output.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async (): Promise<{ readonly [key: string]: unknown }> => {
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        return JSON.parse(line);
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("the agent closed its output");
      buffer += decoder.decode(value, { stream: true });
    }
  };
  return {
    send: (message: unknown) => writer.write(encoder.encode(`${JSON.stringify(message)}\n`)),
    next,
    end: () => writer.close(),
  };
}

const failure = (pending: Promise<unknown>) =>
  pending.then(
    () => undefined,
    (error: unknown) => error,
  );

const clientInfo: acp.Implementation = { name: "an-sdk-client", version: "1.0.0" };

/** The SDK's v1 client, answering permission requests and reading files, recording each update's text. */
function sdkClient(log: Array<string>) {
  return acp
    .client({ name: "an-sdk-client" })
    .onRequest("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "allow-once" } }))
    .onRequest("fs/read_text_file", (ctx) => {
      log.push(`read: ${ctx.params.path}`);
      return { content: "file contents" };
    })
    .onNotification("session/update", ({ params }) => {
      const update = params.update;
      log.push(`update: ${update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? update.content.text : undefined}`);
    });
}

const textPrompt = (sessionId: string, text: string): acp.PromptRequest => ({ sessionId, prompt: [{ type: "text", text }] });

describe("the agent answers initialize itself", () => {
  test("AN2: the SDK's v1 client gets version 1 from an agent implementing versions 1 and 2, and runs a turn with a permission request", async () => {
    const agent = start([v1(), v2()]);
    const log: Array<string> = [];
    const result = await sdkClient(log).connectWith(acp.ndJsonStream(agent.input, agent.output), async (ctx) => {
      const initialized = await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo });
      const { sessionId } = await ctx.request("session/new", { cwd: "/tmp", mcpServers: [] });
      const prompted = await ctx.request("session/prompt", textPrompt(sessionId, "permission"));
      return { initialized, prompted };
    });
    await agent.stop();
    expect(result.initialized.protocolVersion).toBe(1);
    expect(result.initialized.agentInfo).toEqual(info);
    expect(result.prompted.stopReason).toBe("end_turn");
    expect(log).toEqual(["update: Working.", 'update: Answered: {"outcome":"selected","optionId":"allow-once"}']);
  });

  test("AN2: the SDK's v2 client gets version 2 and runs a version 2 turn with a permission request", async () => {
    const agent = start([v1(), v2()]);
    const log: Array<string> = [];
    const client = acpv2
      .client({ name: "an-sdk-client-v2" })
      .onRequest("session/request_permission", (ctx) => {
        log.push(`permission: ${ctx.params.title}`);
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      })
      .onNotification("session/update", ({ params }) => {
        log.push(`update: ${textOf(params.update)}`);
      });
    const result = await client.connectWith(acpv2.ndJsonStream(agent.input, agent.output), async (ctx) => {
      const initialized = await ctx.request("initialize", { protocolVersion: 2, info: clientInfo, capabilities: {} });
      const { sessionId } = await ctx.request("session/new", { cwd: "/tmp" });
      const prompted = await ctx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "permission" }] });
      return { initialized, prompted };
    });
    await agent.stop();
    expect(result.initialized).toMatchObject({ protocolVersion: 2, info, capabilities: { session: {} } });
    expect(result.prompted).toEqual({ messageId: "message-1" });
    expect(log).toEqual([
      "update: Working.",
      "permission: Write a file",
      'update: Answered: {"outcome":"selected","optionId":"allow-once"}',
    ]);
  });

  test("AN2: an initialize offering version 3 is answered 2, in version 2's field names", async () => {
    const agent = start([v1(), v2()]);
    const client = raw(agent);
    await client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 3, info: clientInfo } });
    const answer = await client.next();
    await agent.stop();
    expect(answer).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 2, capabilities: { session: {} }, info },
    });
  });

  test("AN2: an agent implementing only version 1 answers a version 2 client 1, and the SDK's v2 client refuses the answer", async () => {
    const agent = start([v1()]);
    const client = acpv2.client({ name: "an-sdk-client-v2" });
    const refused = await failure(
      client.connectWith(acpv2.ndJsonStream(agent.input, agent.output), (ctx) =>
        ctx.request("initialize", { protocolVersion: 2, info: clientInfo, capabilities: {} }),
      ),
    );
    const answer = agent.sent[0];
    await agent.stop();
    expect(answer).toEqual(
      expect.objectContaining({ result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: info, authMethods: [] } }),
    );
    // The SDK's v2 client parses the answer with its version 2 schema, which requires `info`: the
    // request fails with the schema's validation error, naming `info`. The SDK leaves the stream it
    // was given open; closing it is the caller's.
    expect(refused).toMatchObject({ issues: [{ code: "invalid_type", path: ["info"] }] });
  });

  test("AN3: before initialize a request is answered -32600 not_initialized and a notification is dropped; a second initialize is answered -32600 already_initialized", async () => {
    const agent = start([v1(), v2()]);
    const client = raw(agent);
    await client.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } });
    await client.send({ jsonrpc: "2.0", id: "early", method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    const early = await client.next();
    await client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    const initialized = await client.next();
    await client.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: 1 } });
    const again = await client.next();
    await agent.stop();
    expect(early).toEqual({
      jsonrpc: "2.0",
      id: "early",
      error: { code: -32600, message: "The connection is not initialized", data: { reason: "not_initialized" } },
    });
    expect(initialized).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
    expect(again).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32600, message: "The connection is already initialized", data: { reason: "already_initialized" } },
    });
  });
});

describe("the agent's auth methods", () => {
  test("AN12: a terminal auth method is offered only to a client that advertised terminal auth, in either version, and version 2's auth/login follows the list offered", async () => {
    const v1Methods = [
      decode(V1.AuthMethod, { id: "api-key", name: "API key" }),
      decode(V1.AuthMethod, { type: "terminal", id: "tui", name: "Log in in a terminal" }),
    ];
    const offeredV1 = async (clientCapabilities: acp.ClientCapabilities) => {
      const agent = start([v1({}, v1Methods)]);
      const initialized = await sdkClient([]).connectWith(acp.ndJsonStream(agent.input, agent.output), (ctx) =>
        ctx.request("initialize", { protocolVersion: 1, clientCapabilities, clientInfo }),
      );
      await agent.stop();
      return initialized.authMethods?.map((method) => method.id);
    };
    expect(await offeredV1({})).toEqual(["api-key"]);
    expect(await offeredV1({ auth: { terminal: false } })).toEqual(["api-key"]);
    expect(await offeredV1({ auth: { terminal: true } })).toEqual(["api-key", "tui"]);

    const v2Methods = [decode(V2.AuthMethod, { type: "terminal", methodId: "tui", name: "Log in in a terminal" })];
    const offeredV2 = async (capabilities: acpv2.ClientCapabilities) => {
      const agent = start([v2({ session: {} }, v2Methods)]);
      const result = await acpv2
        .client({ name: "an-sdk-client-v2" })
        .connectWith(acpv2.ndJsonStream(agent.input, agent.output), async (ctx) => {
          const initialized = await ctx.request("initialize", { protocolVersion: 2, info: clientInfo, capabilities });
          const login = await failure(ctx.request("auth/login", { methodId: "tui" }));
          return { offered: initialized.authMethods?.map((method) => method.methodId), login };
        });
      await agent.stop();
      return result;
    };
    const without = await offeredV2({});
    expect(without.offered).toBeUndefined();
    expect(without.login).toMatchObject({ code: -32601, data: { capability: "authMethods" } });
    const withTerminal = await offeredV2({ auth: { terminal: {} } });
    expect(withTerminal.offered).toEqual(["tui"]);
    // Offered, and still refused: a terminal method is one the client runs itself.
    expect(withTerminal.login).toMatchObject({ code: -32602, data: { capability: "authMethods" } });
  });
});

describe("lenient decoding over the wire", () => {
  test("AS5 AS6: the SDK's v1 client sends the agent a default-on-error field that fails to decode and a skip-invalid-items array with an invalid item; the profile and the handler get the default and the array without the item, and the prompt is answered", async () => {
    const handled: Array<unknown> = [];
    const agent = start([
      Agent.implement(Protocol.v1, {
        capabilities: {},
        handlers: (connection) =>
          Effect.succeed({
            "session/new": () => Effect.succeed({ sessionId: V1.SessionId.make("session-1") }),
            "session/prompt": ({ prompt }) =>
              Effect.sync(() => {
                handled.push({ fs: connection.profile.client.capabilities.fs, prompt });
                return { stopReason: "end_turn" as const };
              }),
          }),
      }),
    ]);
    const annotations = { audience: ["user", 5, "assistant"], priority: "high" };
    const prompted = await sdkClient([]).connectWith(acp.ndJsonStream(agent.input, agent.output), async (ctx) => {
      // `fs.readTextFile` defaults to false on error; `audience` skips invalid items; `priority`
      // has no default and is left out.
      const clientCapabilities = { fs: { readTextFile: "yes", writeTextFile: true } } as unknown as acp.ClientCapabilities;
      await ctx.request("initialize", { protocolVersion: 1, clientCapabilities, clientInfo });
      const { sessionId } = await ctx.request("session/new", { cwd: "/tmp", mcpServers: [] });
      const prompt = [{ type: "text", text: "hello", annotations }] as unknown as acp.PromptRequest["prompt"];
      return ctx.request("session/prompt", { sessionId, prompt });
    });
    await agent.stop();
    // The SDK sent the values as given.
    expect(agent.received).toContainEqual(
      expect.objectContaining({ method: "initialize", params: expect.objectContaining({ clientCapabilities: { fs: { readTextFile: "yes", writeTextFile: true } } }) }),
    );
    expect(agent.received).toContainEqual(
      expect.objectContaining({ method: "session/prompt", params: expect.objectContaining({ prompt: [{ type: "text", text: "hello", annotations }] }) }),
    );
    expect(prompted).toEqual({ stopReason: "end_turn" });
    expect(handled).toEqual([
      {
        fs: { readTextFile: false, writeTextFile: true },
        prompt: [{ type: "text", text: "hello", annotations: { audience: ["user", "assistant"] } }],
      },
    ]);
  });
});

describe("the agent's gates on what the client sends", () => {
  const connected = async <A>(capabilities: Parameters<typeof v1>[0], run: (ctx: acp.ClientContext, sessionId: string) => Promise<A>) => {
    const agent = start([v1(capabilities)]);
    const result = await sdkClient([]).connectWith(acp.ndJsonStream(agent.input, agent.output), async (ctx) => {
      await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo });
      const { sessionId } = await ctx.request("session/new", { cwd: "/tmp", mcpServers: [] });
      return run(ctx, sessionId);
    });
    await agent.stop();
    return { result, agent };
  };

  test("AN4: session/load without agentCapabilities.loadSession is answered -32601 naming the capability, before its handler runs", async () => {
    const { result } = await connected({}, (ctx, sessionId) =>
      failure(ctx.request("session/load", { sessionId, cwd: "/tmp", mcpServers: [] })),
    );
    expect(result).toMatchObject({ code: -32601, data: { capability: "agentCapabilities.loadSession" } });
    const allowed = await connected({ loadSession: true }, (ctx, sessionId) =>
      ctx.request("session/load", { sessionId, cwd: "/tmp", mcpServers: [] }),
    );
    expect(allowed.result).toEqual({});
  });

  test("AN4: an image block without promptCapabilities.image is answered -32602 naming the capability", async () => {
    const { result } = await connected({}, (ctx, sessionId) =>
      failure(ctx.request("session/prompt", { sessionId, prompt: [{ type: "image", data: "aGk=", mimeType: "image/png" }] })),
    );
    expect(result).toMatchObject({ code: -32602, data: { capability: "agentCapabilities.promptCapabilities.image" } });
  });

  test("AN4: additionalDirectories without sessionCapabilities.additionalDirectories is answered -32602 naming the capability", async () => {
    const { result } = await connected({}, (ctx) =>
      failure(ctx.request("session/new", { cwd: "/tmp", mcpServers: [], additionalDirectories: ["/var"] })),
    );
    expect(result).toMatchObject({
      code: -32602,
      data: { capability: "agentCapabilities.sessionCapabilities.additionalDirectories" },
    });
  });

  test("AN4: a method the implementation has no handler for is answered -32601", async () => {
    const { result, agent } = await connected({}, (ctx, sessionId) =>
      failure(ctx.request("session/set_mode", { sessionId, modeId: "fast" })),
    );
    expect(result).toMatchObject({ code: -32601 });
    expect(agent.sent).toContainEqual({
      jsonrpc: "2.0",
      id: expect.anything(),
      error: { code: -32601, message: "Method not found: session/set_mode" },
    });
  });
});

describe("the agent's gates on what it sends", () => {
  const turn = async (clientCapabilities: acp.ClientCapabilities, text: string) => {
    const agent = start([v1()]);
    const log: Array<string> = [];
    await sdkClient(log).connectWith(acp.ndJsonStream(agent.input, agent.output), async (ctx) => {
      await ctx.request("initialize", { protocolVersion: 1, clientCapabilities, clientInfo });
      const { sessionId } = await ctx.request("session/new", { cwd: "/tmp", mcpServers: [] });
      await ctx.request("session/prompt", textPrompt(sessionId, text));
    });
    await agent.stop();
    const methods = agent.sent.flatMap((message) => ("method" in message ? [message.method] : []));
    return { log, methods, logged: agent.logged };
  };

  test("AN5: fs/read_text_file is refused with CapabilityNotAdvertised and not sent when the client did not advertise fs, and answered when it did", async () => {
    const refused = await turn({}, "read");
    expect(refused.log).toEqual(["update: Working.", "update: Refused: clientCapabilities.fs.readTextFile"]);
    expect(refused.methods).not.toContain("fs/read_text_file");
    const answered = await turn({ fs: { readTextFile: true } }, "read");
    expect(answered.log).toEqual(["update: Working.", "read: /tmp/an-test.txt", "update: Read: file contents"]);
  });

  test("AN5: elicitation/create is refused when the client advertised elicitation: {}", async () => {
    const refused = await turn({ elicitation: {} }, "elicit");
    expect(refused.log).toEqual(["update: Working.", "update: Refused: clientCapabilities.elicitation.form"]);
    expect(refused.methods).not.toContain("elicitation/create");
  });

  test("AN5: a session/update of kind notice is refused without session.notices", async () => {
    const refused = await turn({}, "notice");
    expect(refused.log).toEqual(["update: Working.", "update: Refused: clientCapabilities.session.notices"]);
    const sent = await turn({ session: { notices: {} } }, "notice");
    expect(sent.log).toEqual(["update: Working.", "update: undefined", "update: Noticed."]);
  });
});

describe("transports", () => {
  test("AN8: runStdio in a subprocess run by BunRuntime.runMain, driven by the SDK's client over pipes: stdout carries only protocol messages, the logs go to stderr, and the process exits 0 when its stdin closes", async () => {
    const child = Bun.spawn([process.execPath, `${import.meta.dir}/negotiation-test-agent-stdio.ts`], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const input = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await child.stdin.write(chunk);
        await child.stdin.flush();
      },
    });
    const [forClient, forTest] = child.stdout.tee();
    const log: Array<string> = [];
    const result = await sdkClient(log).connectWith(acp.ndJsonStream(input, forClient), async (ctx) => {
      const initialized = await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo });
      const { sessionId } = await ctx.request("session/new", { cwd: "/tmp", mcpServers: [] });
      const prompted = await ctx.request("session/prompt", textPrompt(sessionId, "permission"));
      return { initialized, prompted };
    });
    await child.stdin.end();
    // Bounded by the test's timeout: the agent must end the process on its own.
    expect(await child.exited).toBe(0);
    const stdout = await new Response(forTest).text();
    const stderr = await new Response(child.stderr).text();
    expect(result.initialized.protocolVersion).toBe(1);
    expect(result.prompted.stopReason).toBe("end_turn");
    expect(log).toEqual(["update: Working.", 'update: Answered: {"outcome":"selected","optionId":"allow-once"}']);
    const lines = stdout.split("\n").filter((line) => line !== "");
    expect(lines.every((line) => JSON.parse(line).jsonrpc === "2.0")).toBe(true);
    expect(stderr).toContain(logKeys.initialize.negotiated);
  });

  test("AN8: layerHttp, driven by the SDK's createHttpStream client", async () => {
    const web = HttpRouter.toWebHandler(
      Agent.layerHttp({ info, implementations: [v1(), v2()] }).pipe(Layer.provide(Logger.layer([]))),
      { disableLogger: true },
    );
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => web.handler(request) });
    try {
      const log: Array<string> = [];
      const result = await sdkClient(log).connectWith(createHttpStream(`http://127.0.0.1:${server.port}/acp`), async (ctx) => {
        const initialized = await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo });
        const { sessionId } = await ctx.request("session/new", { cwd: "/tmp", mcpServers: [] });
        const prompted = await ctx.request("session/prompt", textPrompt(sessionId, "permission"));
        return { initialized, prompted };
      });
      expect(result.initialized.protocolVersion).toBe(1);
      expect(result.prompted.stopReason).toBe("end_turn");
      expect(log).toEqual(["update: Working.", 'update: Answered: {"outcome":"selected","optionId":"allow-once"}']);
    } finally {
      await web.dispose();
      await server.stop(true);
    }
  });
});

describe("logs", () => {
  test("AN9: initialize is logged at Info with the versions offered and chosen; an incoming refusal at Info with its method and capability; a local refusal at Debug", async () => {
    const agent = start([v1(), v2()]);
    const client = raw(agent);
    await client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 3, info: clientInfo } });
    await client.next();
    // The negotiation is logged after the answer is written; the next answer comes after the log.
    await client.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp" } });
    await client.next();
    await agent.stop();
    expect(agent.logged).toContainEqual({
      level: "Info",
      message: [logKeys.initialize.negotiated, { side: "agent", offered: 3, chosen: 2, supported: [1, 2] }],
    });

    const gated = start([v1()]);
    await sdkClient([]).connectWith(acp.ndJsonStream(gated.input, gated.output), async (ctx) => {
      await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo });
      const { sessionId } = await ctx.request("session/new", { cwd: "/tmp", mcpServers: [] });
      await failure(ctx.request("session/load", { sessionId, cwd: "/tmp", mcpServers: [] }));
      await ctx.request("session/prompt", textPrompt(sessionId, "read"));
    });
    await gated.stop();
    expect(gated.logged).toContainEqual({
      level: "Info",
      message: [
        logKeys.gate.refusedIncoming,
        { side: "agent", method: "session/load", capability: "agentCapabilities.loadSession", code: -32601 },
      ],
    });
    expect(gated.logged).toContainEqual({
      level: "Debug",
      message: [logKeys.gate.refusedLocally, { side: "agent", method: "fs/read_text_file", capability: "clientCapabilities.fs.readTextFile" }],
    });
    expect(gated.logged.filter((line) => line.level === "Warn" || line.level === "Error")).toEqual([]);
  });
});

describe("extension methods", () => {
  test("AN13: the SDK client's request and notification of `_` methods reach the agent's extension handlers, the agent's own reach the SDK client, and an unknown `_` method is -32601", async () => {
    const pinged: Array<string> = [];
    const agent = start([v1WithExtensions(pinged)]);
    const seen: Array<string> = [];
    const result = await acp
      .client({ name: "an-sdk-client" })
      .onRequest(
        "_an/ask",
        (params: unknown) => params as { readonly question: string },
        (ctx) => {
          seen.push(`ask: ${ctx.params.question}`);
          return { answer: "yes" };
        },
      )
      .onNotification(
        "_an/progress",
        (params: unknown) => params as { readonly note: string },
        ({ params }) => {
          seen.push(`progress: ${params.note}`);
        },
      )
      .connectWith(acp.ndJsonStream(agent.input, agent.output), async (ctx) => {
        await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo });
        await ctx.notify("_an/ping", { note: "hello" });
        const echoed = await ctx.request("_an/echo", { text: "ready?" });
        const unknown = await failure(ctx.request("_an/unknown", {}));
        return { echoed, unknown };
      });
    await agent.stop();
    expect(result.echoed).toEqual({ text: "ready?: yes" });
    expect(result.unknown).toMatchObject({ code: -32601 });
    expect(seen).toEqual(["progress: echoing ready?", "ask: ready?"]);
    expect(pinged).toEqual(["hello"]);
  });
});

describe("a connection's lifetime, as its handlers see it", () => {
  test("AP15 AN15: a handler's response is written before its fiber ends; its log lines name its request; handlers run in the connection's scope; open says whether the client cancelled a request or the connection ended", async () => {
    const events: Array<string> = [];
    const prompting = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()];
    let prompts = 0;
    const agent = start([
      Agent.implement(Protocol.v1, {
        capabilities: {},
        handlers: (connection) =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope;
            return {
              "session/new": () =>
                Effect.gen(function* () {
                  const annotations = yield* References.CurrentLogAnnotations;
                  events.push(`request ${JSON.stringify(annotations["request"])}`);
                  yield* Scope.addFinalizer(scope, Effect.sync(() => events.push("connection scope closed")));
                  const self = yield* Effect.fiber;
                  yield* Effect.forkIn(
                    Fiber.await(self).pipe(
                      Effect.andThen(
                        connection.notify(
                          "session/update",
                          decode(V1.SessionNotification, { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after" } } }),
                        ),
                      ),
                      Effect.ignore,
                    ),
                    scope,
                  );
                  return { sessionId: V1.SessionId.make("s1") };
                }),
              "session/prompt": () =>
                Effect.suspend(() => Deferred.succeed(prompting[prompts++] ?? Deferred.makeUnsafe<void>(), undefined)).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Effect.flatMap(connection.open, (open) => Effect.sync(() => events.push(`interrupted, open: ${open}`)))),
                ),
            };
          }),
      }),
    ]);
    const client = raw(agent);
    await client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await client.next();
    await client.send({ jsonrpc: "2.0", id: "new", method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    const first = await client.next();
    const second = await client.next();
    await client.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "s1", prompt: [] } });
    await Effect.runPromise(Deferred.await(prompting[0] ?? Deferred.makeUnsafe<void>()));
    await client.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 3 } });
    const cancelled = await client.next();
    await client.send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: "s1", prompt: [] } });
    await Effect.runPromise(Deferred.await(prompting[1] ?? Deferred.makeUnsafe<void>()));
    await client.end();
    await agent.ended;
    expect(first).toMatchObject({ id: "new", result: { sessionId: "s1" } });
    expect(second).toMatchObject({ method: "session/update", params: { update: { content: { text: "after" } } } });
    expect(cancelled).toMatchObject({ id: 3, error: { code: -32800 } });
    expect(events).toEqual(['request "new"', "interrupted, open: true", "interrupted, open: false", "connection scope closed"]);
  });
});
