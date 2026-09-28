/**
 * Two tools for trying the loop: `add` sums two numbers, `echo` returns its text. The catalog and
 * the runner are defined together, so a tool offered to the model is a tool that runs.
 *
 * A call that cannot run fails with a JSON error the model can act on: a `code`, a `message`, and
 * what to call instead. An unknown tool name gets the catalog; input that does not fit gets the
 * tool's input schema and what was given.
 */

import { Effect, Layer, type Schema } from "effect";
import { ToolName } from "../agent-core/names.ts";
import type { ToolOutcome } from "../agent-core/observation.ts";
import { ToolRunner, type ToolSpec } from "./contracts.ts";
import { parseJson, receivedJson } from "./received.ts";

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

const failed = (error: Schema.Json): ToolOutcome => ({ _tag: "Failed", error: receivedJson(error) });

function notFound(name: ToolName): ToolOutcome {
  return failed({
    code: "tool_not_found",
    message: `No tool is named "${name}".`,
    tools: tools.map((tool) => ({ name: tool.name, input_schema: tool.input })),
  });
}

function invalidInput(tool: SmolTool, message: string, given: Schema.Json | undefined): ToolOutcome {
  return failed({
    code: "invalid_input",
    message,
    tool: tool.name,
    input_schema: tool.input,
    ...(given === undefined ? {} : { given }),
  });
}

function run(name: ToolName, input: Parameters<ToolRunner["Service"]["run"]>[1]): ToolOutcome {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) return notFound(name);
  const parsed = parseJson(input);
  if ("reason" in parsed) return invalidInput(tool, `The input could not be read: ${parsed.reason}.`, undefined);
  const given = parsed.value;
  if (typeof given !== "object" || given === null || Array.isArray(given))
    return invalidInput(tool, `${name} takes an object.`, given);
  const ran = tool.run(given as Schema.JsonObject);
  return "output" in ran
    ? { _tag: "Succeeded", output: receivedJson(ran.output) }
    : invalidInput(tool, ran.misfit, given);
}

export const SmolToolRunner = Layer.succeed(ToolRunner, {
  run: (name, input) => Effect.succeed(run(name, input)),
});
