/** `inWorkspace`, around a tool that records the input it runs with. */

import { expect } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { test } from "../../tests/support/test.ts";
import { ToolName } from "../agent-machine/names.ts";
import { jsonSchemaOf } from "../agent-session/tool-input.ts";
import { inWorkspace } from "./in-workspace.ts";
import { FilePath, FolderPath } from "./paths.ts";
import type { Tool } from "./tool.ts";

const root = "/work/project";

const Input = Schema.Struct({ path: FilePath, at: Schema.optionalKey(FolderPath), count: Schema.Int });

/** A tool that records each input it runs with, and the inputs it recorded. */
const recording = () => {
  const ran: Array<typeof Input.Type> = [];
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

test("inWorkspace resolves each path input against the root, and passes the other inputs to the tool unchanged", async () => {
  const { tool, ran } = recording();
  const wrapped = inWorkspace(root)(tool);
  await Effect.runPromise(wrapped.run({ path: "src/a.ts", at: "src", count: 2 }));
  await Effect.runPromise(wrapped.run({ path: `${root}/b.ts`, count: 3 }));
  expect(ran).toEqual([
    { path: `${root}/src/a.ts`, at: `${root}/src`, count: 2 },
    { path: `${root}/b.ts`, count: 3 },
  ]);
});

test("inWorkspace does not refuse a path outside the root: it resolves it against the root, ~ from the home folder as the policy does, and runs the tool, leaving the path to the permission policy", async () => {
  const { tool, ran } = recording();
  const wrapped = inWorkspace(root)(tool);
  await Effect.runPromise(wrapped.run({ path: "../other/a.ts", at: "/etc", count: 1 }));
  await Effect.runPromise(wrapped.run({ path: "~/notes.md", at: "~", count: 1 }));
  expect(ran).toEqual([
    { path: resolve(root, "../other/a.ts"), at: "/etc", count: 1 },
    { path: join(homedir(), "notes.md"), at: homedir(), count: 1 },
  ]);
});

test("inWorkspace describes a file path and a folder path as relative to the working folder, and changes no other input", () => {
  const { tool } = recording();
  expect(jsonSchemaOf(tool.input)).toMatchObject({ properties: { path: { description: "The file's path." }, at: { description: "The folder's path." } } });
  const offered = jsonSchemaOf(inWorkspace(root)(tool).input);
  expect(offered).toEqual({
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "The file's path: relative to the working folder, or absolute." },
      at: { type: "string", minLength: 1, description: 'The folder\'s path: relative to the working folder, or absolute. "." is the working folder.' },
      count: { type: "integer" },
    },
    required: ["path", "count"],
    additionalProperties: false,
  });
});
