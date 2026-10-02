/**
 * The peer, as the ACP agent in `peer-test-agent.ts`, driven by the official ACP SDK's client
 * (`@agentclientprotocol/sdk` 1.5.0) in this process and over a real stdio pipe. What the SDK cannot
 * provoke (malformed messages, batches, stray responses) is written to the wire as raw JSON.
 */

import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { Deferred, Effect, Exit, Scope, Sink, Stdio, Stream } from "effect";
import type { Wire } from "./json-rpc.ts";
import { type AgentPeer, permissionRequest, runAgent } from "./peer-test-agent.ts";
import { fromStdio, fromWebStreams } from "./stdio.ts";

const encoder = new TextEncoder();

/**
 * The agent in this process on a pair of `TransformStream`s. `input` is what the client writes to
 * the agent and `output` what it reads; `sent` holds every message the agent wrote, and `received`
 * every JSON value it read, as JSON.
 */
interface Agent {
  readonly peer: AgentPeer;
  readonly input: WritableStream<Uint8Array>;
  readonly output: ReadableStream<Uint8Array>;
  readonly sent: ReadonlyArray<string>;
  readonly received: ReadonlyArray<string>;
  readonly hanging: Promise<void>;
  readonly hangInterrupted: Promise<void>;
  readonly close: () => Promise<void>;
}

async function start(): Promise<Agent> {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const wire = fromWebStreams(toAgent.readable, toClient.writable);
  const sent: string[] = [];
  const received: string[] = [];
  const scope = Scope.makeUnsafe();
  const probe = { hanging: Deferred.makeUnsafe<void>(), hangInterrupted: Deferred.makeUnsafe<void>() };
  const recorded: Wire = {
    read: wire.read.pipe(
      Stream.tap((input) => Effect.sync(() => input._tag === "Json" && received.push(JSON.stringify(input.value)))),
    ),
    write: (message) => Effect.suspend(() => (sent.push(JSON.stringify(message)), wire.write(message))),
  };
  const peer = await Effect.runPromise(runAgent(recorded, probe).pipe(Scope.provide(scope)));
  return {
    peer,
    input: toAgent.writable,
    output: toClient.readable,
    sent,
    received,
    hanging: Effect.runPromise(Deferred.await(probe.hanging)),
    hangInterrupted: Effect.runPromise(Deferred.await(probe.hangInterrupted)),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

/** The SDK's stream to an agent started in this process. */
const sdkStream = (agent: Agent) => acp.ndJsonStream(agent.input, agent.output);

/** A client that writes raw text to the agent and reads back what it writes, one line at a time. */
function rawClient(agent: Agent) {
  const writer = agent.input.getWriter();
  const reader = agent.output.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const nextLine = async (): Promise<string> => {
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        return line;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("the agent closed its output");
      buffer += decoder.decode(value, { stream: true });
    }
  };
  return {
    send: (text: string) => writer.write(encoder.encode(text)),
    nextLine,
    next: async (): Promise<unknown> => JSON.parse(await nextLine()),
    end: () => writer.close(),
  };
}

const request = (id: unknown, method: string, params: unknown) => `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

const notification = (method: string, params: unknown) => `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;

type PermissionHandler = acp.ClientRequestHandler<acp.RequestPermissionRequest, acp.RequestPermissionResponse>;

/** A client that logs what it sees, and answers permission requests with `permission`. */
function client(log: string[], permission: PermissionHandler) {
  const firstUpdate = Promise.withResolvers<void>();
  const app = acp
    .client({ name: "peer-test" })
    .onRequest("session/request_permission", permission)
    .onNotification("session/update", ({ params }) => {
      const update = params.update as { readonly content?: { readonly text?: string } };
      log.push(`update: ${update.content?.text}`);
      firstUpdate.resolve();
    });
  return { app, firstUpdate: firstUpdate.promise };
}

const open = async (ctx: acp.ClientContext) => {
  const init = await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  expect(init.protocolVersion).toBe(1);
  return (await ctx.request("session/new", { cwd: "/tmp", mcpServers: [] })).sessionId;
};

const prompt = (sessionId: string, text: string): acp.PromptRequest => ({ sessionId, prompt: [{ type: "text", text }] });

const allowOnce: PermissionHandler = () => ({ outcome: { outcome: "selected", optionId: "allow-once" } });

const failure = (pending: Promise<unknown>) => pending.then(() => undefined, (error: unknown) => error);

describe("a two-way JSON-RPC peer, as an ACP agent, against the official SDK", () => {
  test("AP1: a turn's updates and the agent's own request reach the client before the prompt's response, and nothing of Effect's dialect is written", async () => {
    const agent = await start();
    const log: string[] = [];
    const { app } = client(log, (ctx) => {
      log.push(`permission: ${ctx.params.toolCall.toolCallId}`);
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    });
    const response = await app.connectWith(sdkStream(agent), async (ctx) => {
      const response = await ctx.request("session/prompt", prompt(await open(ctx), "permission"));
      log.push(`response: ${response.stopReason}`);
      return response;
    });
    await agent.close();
    expect(response.stopReason).toBe("end_turn");
    expect(log).toEqual([
      "update: Working.",
      "permission: call-1",
      'update: Answered: {"outcome":"selected","optionId":"allow-once"}',
      "response: end_turn",
    ]);
    expect(agent.sent.join("\n")).not.toMatch(/@effect\/rpc|traceId|spanId|"_tag"|"headers"/);
  });

  test("AP2: session/cancel during a permission question ends the turn cancelled when the client answers cancelled", async () => {
    const agent = await start();
    const asked = Promise.withResolvers<acp.RequestPermissionResponse>();
    const questioned = Promise.withResolvers<void>();
    const { app } = client([], () => {
      questioned.resolve();
      return asked.promise;
    });
    const response = await app.connectWith(sdkStream(agent), async (ctx) => {
      const sessionId = await open(ctx);
      const turn = ctx.request("session/prompt", prompt(sessionId, "permission"));
      await questioned.promise;
      // ACP: the client sends session/cancel and answers every pending question `cancelled`.
      await ctx.notify("session/cancel", { sessionId });
      asked.resolve({ outcome: { outcome: "cancelled" } });
      return turn;
    });
    await agent.close();
    expect(response.stopReason).toBe("cancelled");
  });

  test("AP2: an interrupted call to the other end is cancelled with $/cancel_request, and the turn ends cancelled", async () => {
    const agent = await start();
    let aborted = false;
    const questioned = Promise.withResolvers<void>();
    // This client answers only when the agent cancels the question.
    const { app } = client([], (ctx) => {
      questioned.resolve();
      const answered = Promise.withResolvers<acp.RequestPermissionResponse>();
      ctx.signal.addEventListener("abort", () => {
        aborted = true;
        answered.resolve({ outcome: { outcome: "cancelled" } });
      });
      return answered.promise;
    });
    const response = await app.connectWith(sdkStream(agent), async (ctx) => {
      const sessionId = await open(ctx);
      const turn = ctx.request("session/prompt", prompt(sessionId, "permission"));
      await questioned.promise;
      await ctx.notify("session/cancel", { sessionId });
      return turn;
    });
    await agent.close();
    expect(response.stopReason).toBe("cancelled");
    expect(aborted).toBe(true);
    const cancels = agent.sent.map((line) => JSON.parse(line)).filter((message) => message.method === "$/cancel_request");
    expect(cancels).toHaveLength(1);
    const asked = agent.sent.map((line) => JSON.parse(line)).find((message) => message.method === "session/request_permission");
    expect(cancels[0].params).toEqual({ requestId: asked.id });
  });

  test("AP3: the client cancelling its own request interrupts the handler, and the request ends with -32800", async () => {
    const agent = await start();
    const { app, firstUpdate } = client([], allowOnce);
    const error = await app.connectWith(sdkStream(agent), async (ctx) => {
      const cancel = new AbortController();
      const turn = ctx.request("session/prompt", prompt(await open(ctx), "hang"), { cancellationSignal: cancel.signal });
      await firstUpdate;
      cancel.abort();
      return failure(turn);
    });
    await agent.hangInterrupted;
    await agent.close();
    expect(error).toMatchObject({ code: -32800 });
  });

  test("AP3: a $/cancel_request for an unknown or finished request is ignored", async () => {
    const agent = await start();
    const raw = rawClient(agent);
    await raw.send(request(1, "session/new", { cwd: "/" }));
    expect(await raw.next()).toEqual({ jsonrpc: "2.0", id: 1, result: { sessionId: "session-1" } });
    await raw.send(notification("$/cancel_request", { requestId: 1 }));
    await raw.send(notification("$/cancel_request", { requestId: "never-sent" }));
    await raw.send(request(2, "session/new", { cwd: "/" }));
    expect(await raw.next()).toEqual({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-2" } });
    await agent.close();
  });

  test("AP4: a handler's failure reaches the caller as its own JSON-RPC error", async () => {
    const agent = await start();
    const error = await client([], allowOnce).app.connectWith(sdkStream(agent), async (ctx) =>
      failure(ctx.request("session/prompt", prompt(await open(ctx), "fail"))),
    );
    await agent.close();
    expect(error).toMatchObject({ code: -32042, message: "Refused by the test agent", data: { asked: "fail" } });
  });

  test("AP5: a handler that dies answers its own request with -32603, and the connection goes on", async () => {
    const agent = await start();
    const [died, after] = await client([], allowOnce).app.connectWith(sdkStream(agent), async (ctx) => {
      const sessionId = await open(ctx);
      const died = await failure(ctx.request("session/prompt", prompt(sessionId, "die")));
      return [died, await ctx.request("session/prompt", prompt(sessionId, "hello"))] as const;
    });
    await agent.close();
    expect(died).toMatchObject({ code: -32603 });
    expect(after.stopReason).toBe("end_turn");
  });

  test("AP6: an unknown method is -32601 and params the schema refuses are -32602, before any handler runs", async () => {
    const agent = await start();
    const [unknown, invalid, next] = await client([], allowOnce).app.connectWith(sdkStream(agent), async (ctx) => [
      await failure(ctx.request("_test/unknown", {})),
      await failure(ctx.request("session/new", { cwd: 42 } as never)),
      await ctx.request("session/new", { cwd: "/tmp", mcpServers: [] }),
    ]);
    await agent.close();
    expect(unknown).toMatchObject({ code: -32601 });
    expect(invalid).toMatchObject({ code: -32602 });
    // The refused session/new never reached its handler, which counts the sessions it makes.
    expect(next).toEqual({ sessionId: "session-1" });
  });

  test("AP6: a notification gets no response, whether it is known, unknown or its params are refused; a request with id null is answered under null", async () => {
    const agent = await start();
    const raw = rawClient(agent);
    await raw.send(notification("session/cancel", { sessionId: "session-1" }));
    await raw.send(notification("_test/unknown", {}));
    await raw.send(notification("session/cancel", { sessionId: 5 }));
    await raw.send(request(null, "session/new", { cwd: "/" }));
    expect(await raw.next()).toEqual({ jsonrpc: "2.0", id: null, result: { sessionId: "session-1" } });
    await agent.close();
  });

  test("AP7: a line that is not JSON is -32700 and a JSON value that is not a JSON-RPC message is -32600, with its id when one can be read", async () => {
    const agent = await start();
    const raw = rawClient(agent);
    const error = (id: unknown, code: number) => ({ jsonrpc: "2.0", id, error: expect.objectContaining({ code }) });
    await raw.send("this is not json\n");
    expect(await raw.next()).toEqual(error(null, -32700));
    await raw.send("42\n");
    expect(await raw.next()).toEqual(error(null, -32600));
    await raw.send(`${JSON.stringify({ jsonrpc: "2.0", id: 7 })}\n`);
    expect(await raw.next()).toEqual(error(7, -32600));
    await raw.send(`${JSON.stringify({ jsonrpc: "1.0", id: 8, method: "session/new", params: { cwd: "/" } })}\n`);
    expect(await raw.next()).toEqual(error(8, -32600));
    await raw.send(`${JSON.stringify({ jsonrpc: "2.0", id: "s", method: "session/new", params: "/" })}\n`);
    expect(await raw.next()).toEqual(error("s", -32600));
    // A malformed response: its id is this end's own, so the answer goes under null.
    await raw.send(`${JSON.stringify({ jsonrpc: "2.0", id: 9, result: 1, error: { code: 1, message: "both" } })}\n`);
    expect(await raw.next()).toEqual(error(null, -32600));
    await agent.close();
  });

  test("AP8: a batch is answered with one array of its responses, a batch of notifications with nothing, an empty batch with -32600", async () => {
    const agent = await start();
    const raw = rawClient(agent);
    await raw.send(
      `${JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } },
        { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "none" } },
        { jsonrpc: "2.0", id: 2, method: "_test/unknown", params: {} },
        { nonsense: true },
        { jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: "/" } },
      ])}\n`,
    );
    const batch = (await raw.next()) as Array<{ readonly id: number | null }>;
    expect(Array.isArray(batch)).toBe(true);
    const sorted: unknown = [...batch].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    expect(sorted).toEqual([
      { jsonrpc: "2.0", id: null, error: expect.objectContaining({ code: -32600 }) },
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } },
      { jsonrpc: "2.0", id: 2, error: expect.objectContaining({ code: -32601 }) },
      { jsonrpc: "2.0", id: 3, result: { sessionId: "session-1" } },
    ]);
    await raw.send(
      `${JSON.stringify([
        { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "none" } },
        { jsonrpc: "2.0", method: "_test/unknown" },
      ])}\n`,
    );
    await raw.send("[]\n");
    expect(await raw.next()).toEqual({ jsonrpc: "2.0", id: null, error: expect.objectContaining({ code: -32600 }) });
    await agent.close();
  });

  test("AP9: a response whose id matches no pending call is ignored", async () => {
    const agent = await start();
    const raw = rawClient(agent);
    await raw.send(`${JSON.stringify({ jsonrpc: "2.0", id: 12345, result: { outcome: { outcome: "cancelled" } } })}\n`);
    await raw.send(`${JSON.stringify({ jsonrpc: "2.0", id: 12346, error: { code: -32000, message: "stray" } })}\n`);
    await raw.send(request(1, "session/new", { cwd: "/" }));
    expect(await raw.next()).toEqual({ jsonrpc: "2.0", id: 1, result: { sessionId: "session-1" } });
    await agent.close();
  });

  test("AP10: when the wire's read ends, pending and later calls fail with RpcClientError, running handlers are interrupted, and closed completes", async () => {
    const agent = await start();
    const raw = rawClient(agent);
    await raw.send(request(1, "session/prompt", prompt("session-1", "hang")));
    // The output has no buffer: the turn's update is written only once it is read.
    expect(await raw.next()).toMatchObject({ method: "session/update" });
    await agent.hanging;
    const call = agent.peer.client["session/request_permission"](permissionRequest("session-1"));
    const pending = Effect.runPromise(Effect.flip(call));
    expect(await raw.next()).toMatchObject({ method: "session/request_permission" });
    await raw.end();
    expect(await pending).toMatchObject({ _tag: "RpcClientError", message: "RpcClientDefect: The connection closed" });
    await agent.hangInterrupted;
    await Effect.runPromise(agent.peer.closed);
    expect(await Effect.runPromise(Effect.flip(call))).toMatchObject({ _tag: "RpcClientError" });
    // The interrupted handler's -32800 was not written to the closed connection.
    expect(agent.sent.filter((line) => JSON.parse(line).id === 1)).toEqual([]);
    await agent.close();
  });

  test("AP11: a web-stream wire reads a message split across chunks, several in one chunk, skips blank lines, and writes each message as one compact line", async () => {
    const agent = await start();
    const raw = rawClient(agent);
    const first = request(1, "session/new", { cwd: "/" });
    await raw.send(first.slice(0, 20));
    await raw.send(`${first.slice(20)}\n   \r\n${request(2, "session/new", { cwd: "/" })}`);
    const lines = [await raw.nextLine(), await raw.nextLine()];
    expect(lines.map((line) => JSON.parse(line).id)).toEqual([1, 2]);
    for (const line of lines) expect(line).toBe(JSON.stringify(JSON.parse(line)));
    await agent.close();
  });

  test("AP11: the stdio wire reads and writes newline-delimited JSON through Effect's Stdio service", async () => {
    const written: string[] = [];
    const answered = Promise.withResolvers<void>();
    const decoder = new TextDecoder();
    const first = request(1, "session/new", { cwd: "/" });
    const stdio = Stdio.layerTest({
      // stdin stays open, so the answers are written before the connection ends.
      stdin: Stream.make(first.slice(0, 15), `${first.slice(15)}\n${request(2, "initialize", { protocolVersion: 1 })}not json\n`).pipe(
        Stream.map((text) => encoder.encode(text)),
        Stream.concat(Stream.never),
      ),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Effect.sync(() => {
            written.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
            if (written.length === 3) answered.resolve();
          }),
        ),
    });
    const scope = Scope.makeUnsafe();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runAgent(yield* fromStdio, {
          hanging: yield* Deferred.make<void>(),
          hangInterrupted: yield* Deferred.make<void>(),
        });
      }).pipe(Effect.provide(stdio), Scope.provide(scope)),
    );
    await answered.promise;
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(written.every((line) => line.endsWith("\n") && line.indexOf("\n") === line.length - 1)).toBe(true);
    const messages = written.map((line) => JSON.parse(line));
    expect(messages).toContainEqual({ jsonrpc: "2.0", id: 1, result: { sessionId: "session-1" } });
    expect(messages).toContainEqual(expect.objectContaining({ id: 2, result: expect.objectContaining({ protocolVersion: 1 }) }));
    expect(messages).toContainEqual({ jsonrpc: "2.0", id: null, error: expect.objectContaining({ code: -32700 }) });
  });

  test("AP13: an SDK handler that returns nothing answers null, which reaches the caller as {} when its success schema refuses null and accepts {}", async () => {
    const agent = await start();
    const log: string[] = [];
    const app = client(log, allowOnce).app.onRequest(
      "_test/acknowledge",
      (params: unknown) => params,
      () => undefined,
    );
    const response = await app.connectWith(sdkStream(agent), async (ctx) =>
      ctx.request("session/prompt", prompt(await open(ctx), "acknowledge")),
    );
    await agent.close();
    expect(response.stopReason).toBe("end_turn");
    const asked = agent.sent.map((line) => JSON.parse(line)).find((message) => message.method === "_test/acknowledge");
    expect(agent.received.map((line) => JSON.parse(line))).toContainEqual({ jsonrpc: "2.0", id: asked.id, result: null });
    expect(log).toEqual(["update: Working.", "update: Acknowledged: {}"]);
  });

  test("AP13: a null result becomes {} for a call whose success accepts {}, and is passed on unchanged for one whose success refuses {}, whose call then dies", async () => {
    const agent = await start();
    const raw = rawClient(agent);
    const answerNull = async (method: string) => {
      const asked = (await raw.next()) as { readonly id: number; readonly method: string };
      expect(asked.method).toBe(method);
      await raw.send(`${JSON.stringify({ jsonrpc: "2.0", id: asked.id, result: null })}\n`);
    };
    await raw.send(request(1, "session/prompt", prompt("session-1", "acknowledge")));
    expect(await raw.next()).toMatchObject({ method: "session/update" });
    await answerNull("_test/acknowledge");
    expect(await raw.next()).toMatchObject({ params: { update: { content: { text: "Acknowledged: {}" } } } });
    expect(await raw.next()).toEqual({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
    await raw.send(request(2, "session/prompt", prompt("session-1", "permission")));
    expect(await raw.next()).toMatchObject({ method: "session/update" });
    await answerNull("session/request_permission");
    expect(await raw.next()).toEqual({ jsonrpc: "2.0", id: 2, error: expect.objectContaining({ code: -32603 }) });
    await agent.close();
  });

  test("AP12: over stdio, as an editor launches it, the SDK's client runs a turn, and the agent exits when stdin closes", async () => {
    const child = Bun.spawn([process.execPath, `${import.meta.dir}/peer-test-agent-stdio.ts`], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    const input = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await child.stdin.write(chunk);
        await child.stdin.flush();
      },
    });
    const log: string[] = [];
    const response = await client(log, allowOnce).app.connectWith(acp.ndJsonStream(input, child.stdout), async (ctx) =>
      ctx.request("session/prompt", prompt(await open(ctx), "permission")),
    );
    await child.stdin.end();
    expect(response.stopReason).toBe("end_turn");
    expect(log).toEqual(["update: Working.", 'update: Answered: {"outcome":"selected","optionId":"allow-once"}']);
    expect(await child.exited).toBe(0);
  });
});
