/** `described`, around a tool that records the input it runs with, and run through a tool source. */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { CallId, ToolName } from "../agent-machine/names.ts";
import { receivedJson } from "../agent-session/received.ts";
import { jsonSchemaOf } from "../agent-session/tool-input.ts";
import { callDescriptionOf, described } from "./described.ts";
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

test("described adds a required description input to the tool's input schema, and the tool runs without it", async () => {
  const { tool, ran } = recording();
  const wrapped = described(tool);
  expect(jsonSchemaOf(wrapped.input)).toEqual({
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "The file's path." },
      description: { type: "string", minLength: 1, description: "What this call is for, in one sentence. The user sees it as the call's title." },
    },
    required: ["path", "description"],
    additionalProperties: false,
  });
  await Effect.runPromise(wrapped.run({ path: "a.ts", description: "Read a.ts." }));
  expect(ran).toEqual([{ path: "a.ts" }]);
});

test("a call to a described tool without a description fails as input the tool does not take, and the tool does not run", async () => {
  const { tool, ran } = recording();
  const outcome = await runTest(
    Effect.gen(function* () {
      const source = yield* sourceOf([anyTool(described(tool))]);
      return yield* source.run(ToolName.make("probe"), receivedJson({ path: "a.ts" }), CallId.make("call-1"));
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(outcome).toMatchObject({ _tag: "Failed", reason: { _tag: "InputRejected" } });
  expect(JSON.stringify(outcome)).toContain("description");
  expect(ran).toEqual([]);
});

test("described does not wrap a tool that has an input named description", () => {
  const { tool } = recording();
  const withDescription: Tool<{ readonly description: typeof Schema.String }> = { ...tool, input: Schema.Struct({ description: Schema.String }), run: () => Effect.succeed("ran") };
  // @ts-expect-error The tool's own `description` input would be removed before the tool runs.
  expect(() => described(withDescription)).not.toThrow();
});

test("callDescriptionOf returns the description that a call's input gives, and nothing for an input without one or with an empty one", () => {
  expect(callDescriptionOf({ path: "a.ts", description: "Read a.ts." })).toBe("Read a.ts.");
  expect(callDescriptionOf({ path: "a.ts" })).toBeUndefined();
  expect(callDescriptionOf({ description: "" })).toBeUndefined();
  expect(callDescriptionOf("text")).toBeUndefined();
});
