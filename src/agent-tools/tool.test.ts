/** `sourceOf`, with a tool that asks for the call it runs for. */

import { expect } from "bun:test";
import { Effect, Schema } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { CallId, ToolName } from "../agent-machine/names.ts";
import { asText, receivedJson } from "../agent-session/received.ts";
import { anyTool, CurrentCall, sourceOf, type Tool } from "./tool.ts";

const Input = Schema.Struct({ text: Schema.String });

const callOf: Tool<typeof Input.fields, CurrentCall> = {
  name: ToolName.make("call_of"),
  kind: "read",
  replay: "safe",
  description: "Returns the call's id and its text.",
  input: Input,
  run: (input) => Effect.map(CurrentCall, (call) => `${call}: ${input.text}`),
};

test("sourceOf gives each call's id to the tool that asks for it", async () => {
  const outputs = await runTest(
    Effect.gen(function* () {
      const source = yield* sourceOf([anyTool(callOf)]);
      return yield* Effect.forEach(["call-1", "call-2"], (call) =>
        source.run(ToolName.make("call_of"), receivedJson({ text: "hi" }), CallId.make(call)).pipe(Effect.map((outcome) => (outcome._tag === "Succeeded" ? asText(outcome.output) : outcome._tag))),
      );
    }),
  );
  expect(outputs).toEqual(["call-1: hi", "call-2: hi"]);
});
