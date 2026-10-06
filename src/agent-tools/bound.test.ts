/** `bound`, around a tool that records the input it runs with. */

import { expect } from "bun:test";
import { Effect, Schema } from "effect";
import { test } from "../../tests/support/test.ts";
import { ToolName } from "../agent-machine/names.ts";
import { jsonSchemaOf } from "../agent-session/tool-input.ts";
import { bound } from "./bound.ts";
import { FolderPath } from "./paths.ts";
import type { Tool } from "./tool.ts";

const Input = Schema.Struct({ repository: FolderPath, path: Schema.optionalKey(Schema.NonEmptyString), count: Schema.Int });

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

test("bound removes the inputs it is given from the offered schema, and the tool runs with their values and the call's other inputs", async () => {
  const { tool, ran } = recording();
  const wrapped = bound({ repository: "/work/project" })(tool);
  expect(jsonSchemaOf(wrapped.input)).toEqual({
    type: "object",
    properties: { path: { type: "string", minLength: 1 }, count: { type: "integer" } },
    required: ["count"],
    additionalProperties: false,
  });
  await Effect.runPromise(wrapped.run({ path: "a.ts", count: 2 }));
  expect(ran).toEqual([{ repository: "/work/project", path: "a.ts", count: 2 }]);
});

test("bound takes only inputs that the tool has, with values of the inputs' types", () => {
  const { tool } = recording();
  // @ts-expect-error The tool has no input named branch.
  expect(() => bound({ branch: "main" })(tool)).not.toThrow();
  // @ts-expect-error count is an integer, not text.
  expect(() => bound({ count: "two" })(tool)).not.toThrow();
});
