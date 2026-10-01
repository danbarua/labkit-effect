/**
 * SPIKE: the Effect peer, as an ACP agent, driven by the official ACP SDK's client
 * (`@agentclientprotocol/sdk` 1.5.0) in the same process, and once over a real stdio pipe.
 */

import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { Deferred, Effect, Exit, Scope, Stream } from "effect";
import { runAgent } from "./acp-agent.ts";

const encoder = new TextEncoder();

/** The agent in this process, and the SDK's stream to it. `sent` holds every line the agent wrote. */
async function inProcess() {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const writer = toClient.writable.getWriter();
  const sent: string[] = [];
  const scope = Scope.makeUnsafe();
  const hangInterrupted = Deferred.makeUnsafe<void>();
  await Effect.runPromise(
    runAgent(
      {
        read: Stream.fromReadableStream({ evaluate: () => toAgent.readable, onError: (error) => error }),
        write: (line) =>
          Effect.promise(() => {
            sent.push(line);
            return writer.write(encoder.encode(line));
          }),
      },
      { hangInterrupted },
    ).pipe(Scope.provide(scope)),
  );
  return {
    stream: acp.ndJsonStream(toAgent.writable, toClient.readable),
    sent,
    hangInterrupted: Effect.runPromise(Deferred.await(hangInterrupted)),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

type PermissionHandler = acp.ClientRequestHandler<acp.RequestPermissionRequest, acp.RequestPermissionResponse>;

/** A client that logs what it sees, and answers permission requests with `permission`. */
function client(log: string[], permission: PermissionHandler) {
  const firstUpdate = Promise.withResolvers<void>();
  const app = acp
    .client({ name: "spike-test" })
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

const failure = (request: Promise<unknown>) => request.then(() => undefined, (error: unknown) => error);

describe("a two-way JSON-RPC peer in Effect, as an ACP agent, against the official SDK", () => {
  test("a turn's updates and the agent's own request reach the client before the prompt's response", async () => {
    const agent = await inProcess();
    const log: string[] = [];
    const { app } = client(log, (ctx) => {
      log.push(`permission: ${ctx.params.toolCall.toolCallId}`);
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    });
    const response = await app.connectWith(agent.stream, async (ctx) => {
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
    // Nothing of Effect's own dialect reaches the wire.
    expect(agent.sent.join("")).not.toMatch(/@effect\/rpc|traceId|"_tag"/);
  });

  test("session/cancel during a permission question ends the turn cancelled, as a real client answers", async () => {
    const agent = await inProcess();
    const asked = Promise.withResolvers<acp.RequestPermissionResponse>();
    const questioned = Promise.withResolvers<void>();
    const { app } = client([], () => {
      questioned.resolve();
      return asked.promise;
    });
    const response = await app.connectWith(agent.stream, async (ctx) => {
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

  test("a question still waiting when session/cancel arrives is cancelled with $/cancel_request", async () => {
    const agent = await inProcess();
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
    const response = await app.connectWith(agent.stream, async (ctx) => {
      const sessionId = await open(ctx);
      const turn = ctx.request("session/prompt", prompt(sessionId, "permission"));
      await questioned.promise;
      await ctx.notify("session/cancel", { sessionId });
      return turn;
    });
    await agent.close();
    expect(response.stopReason).toBe("cancelled");
    expect(aborted).toBe(true);
    expect(agent.sent.filter((line) => JSON.parse(line).method === "$/cancel_request")).toHaveLength(1);
  });

  test("the client cancelling its own request interrupts the handler, and the request ends with -32800", async () => {
    const agent = await inProcess();
    const { app, firstUpdate } = client([], allowOnce);
    const error = await app.connectWith(agent.stream, async (ctx) => {
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

  test("a handler's failure reaches the caller as its own JSON-RPC error", async () => {
    const agent = await inProcess();
    const error = await client([], allowOnce).app.connectWith(agent.stream, async (ctx) =>
      failure(ctx.request("session/prompt", prompt(await open(ctx), "fail"))),
    );
    await agent.close();
    expect(error).toMatchObject({ code: -32042, message: "Refused by the spike", data: { asked: "fail" } });
  });

  test("a handler that dies answers its own request with -32603, and the connection goes on", async () => {
    const agent = await inProcess();
    const [died, after] = await client([], allowOnce).app.connectWith(agent.stream, async (ctx) => {
      const sessionId = await open(ctx);
      const died = await failure(ctx.request("session/prompt", prompt(sessionId, "die")));
      return [died, await ctx.request("session/prompt", prompt(sessionId, "hello"))] as const;
    });
    await agent.close();
    expect(died).toMatchObject({ code: -32603 });
    expect(after.stopReason).toBe("end_turn");
  });

  test("an unknown method is -32601 and params the schema refuses are -32602", async () => {
    const agent = await inProcess();
    const [unknown, invalid] = await client([], allowOnce).app.connectWith(agent.stream, async (ctx) => [
      await failure(ctx.request("_spike/unknown", {})),
      await failure(ctx.request("session/new", { cwd: 42 } as never)),
    ]);
    await agent.close();
    expect(unknown).toMatchObject({ code: -32601 });
    expect(invalid).toMatchObject({ code: -32602 });
  });

  test("over stdio, as an editor launches it", async () => {
    const child = Bun.spawn(["bun", `${import.meta.dir}/acp-agent-stdio.ts`], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    const input = new WritableStream<Uint8Array>({
      write: (chunk) => {
        child.stdin.write(chunk);
        child.stdin.flush();
      },
    });
    const log: string[] = [];
    const response = await client(log, allowOnce).app.connectWith(acp.ndJsonStream(input, child.stdout), async (ctx) =>
      ctx.request("session/prompt", prompt(await open(ctx), "permission")),
    );
    child.stdin.end();
    expect(response.stopReason).toBe("end_turn");
    expect(log).toEqual(["update: Working.", 'update: Answered: {"outcome":"selected","optionId":"allow-once"}']);
    expect(await child.exited).toBe(0);
  });
});
