/** `described`, around a tool that records the input it runs with, and run through a tool source. */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { CallId, ToolName } from "../agent-machine/names.ts";
import { receivedJson } from "../agent-session/received.ts";
import { jsonSchemaOf } from "../agent-session/tool-input.ts";
import { described, intentOf } from "./described.ts";
import { FilePath } from "./paths.ts";
import { anyTool, sourceOf, type Tool } from "./tool.ts";

const Input = Schema.Struct({ path: FilePath });

/** A tool that records each input it runs with, and the inputs it recorded. */
const recording = () => {
  const ran: Array<unknown> = [];
  const tool: Tool<typeof Input.fields> = {
    name: ToolName.make("probe"),
    kind: "read",
    replay: "safe",
    description: "Records its input.",
    input: Input,
    run: (input) =>
      Effect.sync(() => {
        ran.push(input);
        return "ran";
      }),
  };
  return { tool, ran };
};

test("described adds a required intent input to the tool's input schema, and the tool runs without it", async () => {
  const { tool, ran } = recording();
  const wrapped = described(tool);
  expect(jsonSchemaOf(wrapped.input)).toEqual({
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "The file's path." },
      intent: { type: "string", minLength: 1, description: "What this call is for, in one sentence. The user sees it as the call's title." },
    },
    required: ["path", "intent"],
    additionalProperties: false,
  });
  await Effect.runPromise(wrapped.run({ path: "a.ts", intent: "Read a.ts." }));
  expect(ran).toEqual([{ path: "a.ts" }]);
});

test("a call to a described tool without an intent fails as input the tool does not take, and the tool does not run", async () => {
  const { tool, ran } = recording();
  const outcome = await runTest(
    Effect.gen(function* () {
      const source = yield* sourceOf([anyTool(described(tool))]);
      return yield* source.run(ToolName.make("probe"), receivedJson({ path: "a.ts" }), CallId.make("call-1"));
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(outcome).toMatchObject({ _tag: "Failed", reason: { _tag: "InputRejected" } });
  expect(JSON.stringify(outcome)).toContain("intent");
  expect(ran).toEqual([]);
});

test("described does not wrap a tool that has an input named intent, and wraps one that has an input named description", () => {
  const { tool } = recording();
  const withIntent: Tool<{ readonly intent: typeof Schema.String }> = { ...tool, input: Schema.Struct({ intent: Schema.String }), run: () => Effect.succeed("ran") };
  // @ts-expect-error The tool's own `intent` input would be removed before the tool runs.
  expect(() => described(withIntent)).not.toThrow();
  const withDescription: Tool<{ readonly description: typeof Schema.String }> = { ...tool, input: Schema.Struct({ description: Schema.String }), run: () => Effect.succeed("ran") };
  expect(jsonSchemaOf(described(withDescription).input)).toMatchObject({ properties: { description: { type: "string" }, intent: { type: "string" } }, required: ["description", "intent"] });
});

test("intentOf returns the intent that a call's input gives, and nothing for an input without one or with an empty one", () => {
  expect(intentOf({ path: "a.ts", intent: "Read a.ts." })).toBe("Read a.ts.");
  expect(intentOf({ path: "a.ts", description: "Not an intent." })).toBeUndefined();
  expect(intentOf({ intent: "" })).toBeUndefined();
  expect(intentOf("text")).toBeUndefined();
});
