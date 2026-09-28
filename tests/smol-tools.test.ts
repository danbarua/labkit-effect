import { expect, test } from "bun:test";
import { Effect, type Schema } from "effect";
import { ToolName } from "../src/agent-core/names.ts";
import { ToolRunner } from "../src/agent-effect/contracts.ts";
import { receivedJson } from "../src/agent-effect/received.ts";
import { SmolToolRunner } from "../src/agent-effect/smol-tools.ts";

test("the runner reports why a call failed, and formats nothing", async () => {
  const run = (name: string, input: unknown) =>
    Effect.runPromise(
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
