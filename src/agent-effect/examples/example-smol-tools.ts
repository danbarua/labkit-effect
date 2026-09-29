/**
 * Two tools for trying the loop: `add` sums two numbers, `echo` returns its text. The catalog and
 * the runner are defined together, so a tool offered to the model is a tool that runs.
 *
 * A call that cannot run fails with the reason: no tool has the name (`NotFound`), or the input
 * does not fit (`InputRejected`). How that reads to the model is the provider adapter's business.
 */

import { Effect, Layer, type Schema } from "effect";
import { FailureText, ToolName } from "../../agent-core/names.ts";
import type { ToolOutcome } from "../../agent-core/observation.ts";
import { ToolRunner, type ToolSpec } from "../contracts.ts";
import { parseJson, receivedJson } from "../received.ts";

/** A tool's result: its output, or why the input does not fit. */
type Ran = { readonly output: Schema.Json } | { readonly misfit: string };

interface SmolTool extends ToolSpec {
  readonly run: (input: Schema.JsonObject) => Ran;
}

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
        ? { output: input["a"] + input["b"] }
        : { misfit: "add needs two numbers, a and b." },
  },
  {
    name: ToolName.make("echo"),
    description: "Returns the text it is given.",
    input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: (input) =>
      typeof input["text"] === "string" ? { output: input["text"] } : { misfit: "echo needs a text." },
  },
];

export const smolCatalog: ReadonlyArray<ToolSpec> = tools.map(({ name, description, input }) => ({
  name,
  description,
  input,
}));

const rejected = (problem: string): ToolOutcome => ({
  _tag: "Failed",
  reason: { _tag: "InputRejected", problem: FailureText.make(problem) },
});

function run(name: ToolName, input: Parameters<ToolRunner["Service"]["run"]>[1]): ToolOutcome {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) return { _tag: "Failed", reason: { _tag: "NotFound" } };
  const parsed = parseJson(input);
  if ("reason" in parsed) return rejected(`The input could not be read: ${parsed.reason}.`);
  const given = parsed.value;
  if (typeof given !== "object" || given === null || Array.isArray(given))
    return rejected(`${name} takes an object.`);
  const ran = tool.run(given as Schema.JsonObject);
  return "output" in ran ? { _tag: "Succeeded", output: receivedJson(ran.output) } : rejected(ran.misfit);
}

export const SmolToolRunner = Layer.succeed(ToolRunner, {
  run: (name, input) => Effect.succeed(run(name, input)),
});
