/**
 * Two tools for trying the loop: `add` sums two numbers, `echo` returns its text. The catalog and
 * the runner are defined together, so a tool offered to the model is a tool that runs.
 */

import { Effect, Layer, type Schema } from "effect";
import { FailureText, ToolName } from "../agent-core/names.ts";
import type { ToolOutcome } from "../agent-core/observation.ts";
import { ToolRunner, type ToolSpec } from "./contracts.ts";

interface SmolTool extends ToolSpec {
  readonly run: (input: Schema.JsonObject) => ToolOutcome;
}

const failed = (failure: string): ToolOutcome => ({ _tag: "Failed", failure: FailureText.make(failure) });

const tools: ReadonlyArray<SmolTool> = [
  {
    name: ToolName.make("add"),
    description: "Adds two numbers.",
    input: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
    run: (input) =>
      typeof input["a"] === "number" && typeof input["b"] === "number"
        ? { _tag: "Succeeded", output: input["a"] + input["b"] }
        : failed(`add needs two numbers, a and b; it was given ${JSON.stringify(input)}`),
  },
  {
    name: ToolName.make("echo"),
    description: "Returns the text it is given.",
    input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: (input) =>
      typeof input["text"] === "string"
        ? { _tag: "Succeeded", output: input["text"] }
        : failed(`echo needs a text; it was given ${JSON.stringify(input)}`),
  },
];

export const smolCatalog: ReadonlyArray<ToolSpec> = tools.map(({ name, description, input }) => ({
  name,
  description,
  input,
}));

export const SmolToolRunner = Layer.succeed(ToolRunner, {
  run: (name, input) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) return Effect.succeed(failed(`there is no tool named ${name}`));
    if (typeof input !== "object" || input === null || Array.isArray(input))
      return Effect.succeed(failed(`${name} needs an object as input; it was given ${JSON.stringify(input)}`));
    return Effect.succeed(tool.run(input as Schema.JsonObject));
  },
});
