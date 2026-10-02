/**
 * Tools for a workspace, a folder on disk: `read_file` and `list_dir`, which read, and `write_file`,
 * which changes it. Each tool is its catalog entry (what the model is offered, with its kind, which
 * a permission policy reads) and the function that runs it, defined together, so a tool offered is
 * a tool that runs. `workspaceTools(root)` gives the catalog, for a session's opening, and the
 * `ToolRunner` that runs a call.
 *
 * A path is relative to the root, or absolute; one that is not inside the root is not accepted.
 * `read_file` reads UTF-8 text, at most 256 KiB in one result; `line` (1-based) and `limit` (a
 * count of lines) read part of a file. `list_dir` lists one folder, without recursion, a folder's
 * name followed by `/`. `write_file` creates or replaces a file with at most 256 KiB of text; the
 * folder it is in must exist. Run again for a call whose end was not observed, `read_file` and
 * `list_dir` change nothing (`replay: "safe"`), and `write_file` writes the same text to the same
 * file (`"idempotent"`).
 *
 * A call that cannot run fails with the reason: no tool has the name (`NotFound`), the input does
 * not fit (`InputRejected`), or the file system reported an error (`Reported`, with its message).
 */

import { isAbsolute, relative, resolve } from "node:path";
import { Data, Effect, FileSystem, Layer, Schema } from "effect";
import { FailureText, ToolName } from "../agent-machine/names.ts";
import type { ToolOutcome } from "../agent-machine/observation.ts";
import { ToolRunner, type ToolSpec } from "../agent-session/contracts.ts";
import { parseJson, receivedText } from "../agent-session/received.ts";

/** The most bytes `read_file` returns in one result. */
export const maxReadBytes = 256 * 1024;

const ReadFile = Schema.Struct({
  path: Schema.NonEmptyString,
  line: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
const ListDir = Schema.Struct({ path: Schema.NonEmptyString });
const WriteFile = Schema.Struct({ path: Schema.NonEmptyString, text: Schema.String });

interface WorkspaceTool<I> extends ToolSpec {
  readonly decode: (input: unknown) => Effect.Effect<I, Schema.SchemaError>;
  readonly run: (input: I) => Effect.Effect<string, Rejected | Reported, FileSystem.FileSystem>;
}

/** The input names a path outside the workspace, or otherwise does not fit. */
class Rejected extends Data.TaggedError("Rejected")<{ readonly problem: string }> {}
/** The file system reported an error. */
class Reported extends Data.TaggedError("Reported")<{ readonly message: string }> {}

const tool = <I>(definition: WorkspaceTool<I>): WorkspaceTool<unknown> => definition as unknown as WorkspaceTool<unknown>;

export function workspaceTools(root: string) {
  const inside = (path: string) => {
    const full = resolve(root, path);
    const from = relative(root, full);
    return from.startsWith("..") || isAbsolute(from)
      ? Effect.fail(new Rejected({ problem: `${path} is not inside the workspace, ${root}.` }))
      : Effect.succeed(full);
  };
  const reported = (path: string) => (error: { readonly message: string }) => new Reported({ message: `${path}: ${error.message}` });
  const scope = ` Relative paths are inside the workspace, ${root}.`;

  const tools: ReadonlyArray<WorkspaceTool<unknown>> = [
    tool({
      name: ToolName.make("read_file"),
      kind: "read",
      replay: "safe",
      description: `Read a UTF-8 file in the workspace, at most 256 KiB per result. Use line (1-based) and limit (a count of lines) to read a large file in parts, for example {"path": "src/a.ts", "line": 1, "limit": 100}. If a path does not exist, list its folder with list_dir.${scope}`,
      input: {
        type: "object",
        properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } },
        required: ["path"],
      },
      decode: Schema.decodeUnknownEffect(ReadFile),
      run: ({ path, line, limit }) =>
        Effect.gen(function* () {
          const full = yield* inside(path);
          const fs = yield* FileSystem.FileSystem;
          const text = yield* fs.readFileString(full).pipe(Effect.mapError(reported(path)));
          const whole = line === undefined && limit === undefined;
          const start = (line ?? 1) - 1;
          const part = whole ? text : text.split("\n").slice(start, limit === undefined ? undefined : start + limit).join("\n");
          if (Buffer.byteLength(part) <= maxReadBytes) return part;
          const fewer = { path, line: line ?? 1, limit: limit === undefined ? 100 : Math.max(1, Math.floor(limit / 2)) };
          return yield* new Rejected({ problem: `The result is over 256 KiB. Read fewer lines: ${JSON.stringify(fewer)}.` });
        }),
    } satisfies WorkspaceTool<typeof ReadFile.Type>),
    tool({
      name: ToolName.make("list_dir"),
      kind: "search",
      replay: "safe",
      description: `List one folder in the workspace, without recursion; a folder's name ends with /. Use "." for the workspace itself.${scope}`,
      input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      decode: Schema.decodeUnknownEffect(ListDir),
      run: ({ path }) =>
        Effect.gen(function* () {
          const full = yield* inside(path);
          const fs = yield* FileSystem.FileSystem;
          const names = yield* fs.readDirectory(full).pipe(Effect.mapError(reported(path)));
          const listed = yield* Effect.forEach([...names].sort(), (name) =>
            fs.stat(resolve(full, name)).pipe(
              Effect.map((info) => (info.type === "Directory" ? `${name}/` : name)),
              Effect.mapError(reported(`${path}/${name}`)),
            ),
          );
          return listed.join("\n");
        }),
    } satisfies WorkspaceTool<typeof ListDir.Type>),
    tool({
      name: ToolName.make("write_file"),
      kind: "edit",
      replay: "idempotent",
      description: `Create a UTF-8 file in the workspace, or replace one, with the text given, at most 256 KiB. The folder it is in must exist.${scope}`,
      input: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } }, required: ["path", "text"] },
      decode: Schema.decodeUnknownEffect(WriteFile),
      run: ({ path, text }) =>
        Effect.gen(function* () {
          const full = yield* inside(path);
          const bytes = Buffer.byteLength(text);
          if (bytes > maxReadBytes) return yield* new Rejected({ problem: `The text is over 256 KiB (${bytes} bytes). Write less.` });
          yield* (yield* FileSystem.FileSystem).writeFileString(full, text).pipe(Effect.mapError(reported(path)));
          return `Wrote ${bytes} bytes to ${path}.`;
        }),
    } satisfies WorkspaceTool<typeof WriteFile.Type>),
  ];

  const catalog: ReadonlyArray<ToolSpec> = tools.map(({ name, description, input, kind, replay }) => ({ name, description, input, kind, replay }));

  const rejected = (problem: string): ToolOutcome => ({ _tag: "Failed", reason: { _tag: "InputRejected", problem: FailureText.make(problem) } });

  /** Runs the tool a call names on its input, with the file system it is given. */
  const runner = Layer.effect(
    ToolRunner,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return {
        run: (name, input) => {
          const found = tools.find((each) => each.name === name);
          if (found === undefined) return Effect.succeed<ToolOutcome>({ _tag: "Failed", reason: { _tag: "NotFound" } });
          const parsed = parseJson(input);
          if ("reason" in parsed) return Effect.succeed(rejected(`The input could not be read: ${parsed.reason}.`));
          return found.decode(parsed.value).pipe(
            Effect.mapError((error) => new Rejected({ problem: `${name} does not take this input: ${error.message}` })),
            Effect.flatMap(found.run),
            Effect.map((output): ToolOutcome => ({ _tag: "Succeeded", output: receivedText(output) })),
            Effect.catchTags({
              Rejected: (error) => Effect.succeed(rejected(error.problem)),
              Reported: (error) => Effect.succeed<ToolOutcome>({ _tag: "Failed", reason: { _tag: "Reported", error: receivedText(error.message) } }),
            }),
            Effect.provideService(FileSystem.FileSystem, fs),
          );
        },
      };
    }),
  );

  return { catalog, runner };
}
