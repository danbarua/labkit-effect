/** The MCP client, against a small server over stdio (`tests/support/mcp-server.ts`). */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Logger } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { connectStdio, McpFailed, protocolVersion } from "./client.ts";
import { logKeys } from "./log-keys.ts";

const fake = { name: "fake", command: process.execPath, args: [new URL("../../tests/support/mcp-server.ts", import.meta.url).pathname], env: {} };
const roots = [{ uri: "file:///work", name: "work" }];

/** Runs `use` with a connection to the test server; what it gives, and the server's log messages. */
const connected = <A, E>(use: (connection: Effect.Success<ReturnType<typeof connectStdio>>) => Effect.Effect<A, E>) => {
  const logged: Array<unknown> = [];
  const capture = Logger.make((options) => {
    logged.push(options.message);
  });
  return runTest(
    connectStdio(fake, roots).pipe(
      Effect.flatMap(use),
      Effect.provide(Layer.mergeAll(BunServices.layer, Logger.layer([capture], { mergeWithExisting: true }))),
    ),
  ).then((value) => ({ value, logged: logged.flat() }));
};

const textOf = (result: { readonly content: ReadonlyArray<unknown> }) =>
  result.content.flatMap((block) => (typeof block === "object" && block !== null && "text" in block ? [String(block.text)] : [])).join("");

test("MC1 MC5: initialize offers this client's version and the server's answer is kept; its tools are listed across pages; a call gives the tool's result", async () => {
  const { value, logged } = await connected((connection) =>
    Effect.gen(function* () {
      const tools = yield* connection.tools;
      const echoed = yield* connection.call("echo", { message: "hi" });
      return { server: connection.initialized.serverInfo.name, version: connection.initialized.protocolVersion, tools: tools.map((tool) => tool.name), echoed: textOf(echoed) };
    }),
  );
  expect(value).toEqual({ server: "fake", version: protocolVersion, tools: ["echo", "roots", "slow"], echoed: "hi" });
  // The server logged once it was told initialization was done.
  expect(logged).toContainEqual(logKeys.server.logged);
});

test("MC2: the server's own request during a call (roots/list) is answered with the roots the client was given", async () => {
  const { value } = await connected((connection) => Effect.map(connection.call("roots", {}), textOf));
  expect(JSON.parse(value)).toEqual({ roots: [{ uri: "file:///work", name: "work" }] });
});

test("MC3: a call interrupted is cancelled at the server (notifications/cancelled, with its request id)", async () => {
  const { logged } = await connected((connection) =>
    Effect.gen(function* () {
      yield* connection.call("slow", {}).pipe(Effect.timeout("200 millis"), Effect.ignore);
      // The server's log message saying it was told to cancel.
      yield* Effect.sleep("200 millis");
    }),
  );
  const said = logged.filter((each): each is { data: string } => typeof each === "object" && each !== null && "data" in each).map((each) => each.data);
  expect(said.some((data) => /^cancelled \d+$/.test(data))).toBe(true);
});

test("MC4: a request the server answers with an error fails with McpFailed, naming the server and the request", async () => {
  const { value } = await connected((connection) => Effect.flip(connection.call("no_such_tool", {})));
  expect(value).toBeInstanceOf(McpFailed);
  expect(value.message).toBe("fake: tools/call no_such_tool failed");
});
