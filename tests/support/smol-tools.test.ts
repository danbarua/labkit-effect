import { expect } from "bun:test";
import { test } from "../support/test.ts";
import { Effect, type Schema } from "effect";
import { ToolName } from "../../src/agent-machine/names.ts";
import { ToolRunner } from "../../src/agent-session/contracts.ts";
import { receivedJson } from "../../src/agent-session/received.ts";
import { SmolToolRunner } from "./smol-tools.ts";
import { runTest } from "./run.ts";

test("the runner reports why a call failed, and formats nothing", async () => {
  const run = (name: string, input: unknown) =>
    runTest(
      Effect.gen(function* () {
        return yield* (yield* ToolRunner).run(ToolName.make(name), receivedJson(input as Schema.Json));
      }).pipe(Effect.provide(SmolToolRunner)),
    );
  expect(await run("___read_", { path: "a.ts" })).toEqual({ _tag: "Failed", reason: { _tag: "NotFound" } });
  expect((await run("add", { a: "2" })) as unknown).toEqual({
    _tag: "Failed",
    reason: { _tag: "InputRejected", problem: "add needs two numbers, a and b." },
  });
});
