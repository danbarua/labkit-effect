/** The Anthropic Messages adapter: how the core's types are shaped into its wire format. */

import { afterAll, expect, test } from "bun:test";
import { Effect, Layer, Logger } from "effect";
import { ModelName, ProviderName, TurnId } from "../src/agent-core/names.ts";
import { ModelClient } from "../src/agent-effect/contracts.ts";
import { logKeys } from "../src/agent-effect/log-keys.ts";
import type { Observation } from "../src/agent-core/observation.ts";
import { BoringModelProvider, CountingTurns } from "../src/agent-effect/boring.ts";
import { AnthropicModelClient } from "../src/agent-effect/anthropic-client.ts";
import { openSession } from "../src/agent-effect/loop.ts";
import { SmolToolRunner, smolCatalog } from "../src/agent-effect/smol-tools.ts";
import { ToolContextAssembler } from "../src/agent-effect/tool-context.ts";

/** A provider that makes one scripted tool call, then answers; it keeps every request it is sent. */
function scripted(call: { name: string; input: unknown }) {
  const received: Array<{ messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      received.push((await request.json()) as (typeof received)[number]);
      return Response.json(
        received.length === 1
          ? { content: [{ type: "tool_use", id: "toolu_1", ...call }], stop_reason: "tool_use" }
          : { content: [{ type: "text", text: "Understood." }], stop_reason: "end_turn" },
      );
    },
  });
  return { server, received };
}

const servers: Array<{ stop: (force: boolean) => unknown }> = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

/** Runs one turn against the scripted provider and returns the tool result the model was sent. */
async function toolResultSent(call: { name: string; input: unknown }) {
  const provider = scripted(call);
  servers.push(provider.server);
  await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe({ _tag: "SessionOpened", session: "s1" } as unknown as Observation);
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "go" } as unknown as Observation);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider(new URL("/v1/messages", provider.server.url)),
          ToolContextAssembler(smolCatalog),
          AnthropicModelClient,
          CountingTurns,
          SmolToolRunner,
        ),
      ),
    ),
  );
  const result = provider.received[1]?.messages.at(-1)?.content[0];
  if (result === undefined) throw new Error("the model was not sent a tool result");
  return { ...result, content: JSON.parse(result["content"] as string) } as unknown;
}

test("a failed call to a tool that does not exist is sent as the tools that do", async () => {
  expect(await toolResultSent({ name: "___read_", input: { path: "a.ts" } })).toEqual({
    type: "tool_result",
    tool_use_id: "toolu_1",
    is_error: true,
    content: {
      code: "tool_not_found",
      message: 'No tool is named "___read_".',
      tools: smolCatalog.map((tool) => ({ name: tool.name, input_schema: tool.input })),
    },
  });
});

test("a failed call with input that does not fit is sent as the tool's schema and what was given", async () => {
  expect(await toolResultSent({ name: "add", input: { a: "2" } })).toEqual({
    type: "tool_result",
    tool_use_id: "toolu_1",
    is_error: true,
    content: {
      code: "invalid_input",
      message: "add needs two numbers, a and b.",
      tool: "add",
      input_schema: smolCatalog[0]?.input,
      given: { a: "2" },
    },
  });
});

test("the max_tokens the Messages API requires is supplied and logged, with the reason", async () => {
  const logged: Array<{ level: string; message: unknown }> = [];
  const capture = Logger.make((options) => {
    logged.push({ level: options.logLevel, message: options.message });
  });
  const provider = scripted({ name: "add", input: { a: 1, b: 2 } });
  servers.push(provider.server);
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* ModelClient;
      yield* client.respond(
        {
          provider: ProviderName.make("boring"),
          model: ModelName.make("boring-1"),
          endpoint: new URL("/v1/messages", provider.server.url),
        },
        { system: undefined, tools: [], messages: [{ role: "user", parts: [{ _tag: "Text", text: "hi" }] }] },
        TurnId.make("turn-1"),
      );
    }).pipe(Effect.provide(Layer.mergeAll(AnthropicModelClient, Logger.layer([capture])))),
  );
  expect(logged).toContainEqual({
    level: "Info",
    message: [
      logKeys.anthropic.maxTokensSupplied,
      {
        turn: "turn-1",
        max_tokens: 1024,
        reason: "the Messages API requires max_tokens and the context sets no output limit",
      },
    ],
  });
});
