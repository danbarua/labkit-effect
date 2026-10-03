/**
 * Tools for a workspace, a folder on disk: `read_file` and `list_dir`, which read; `write_file` and
 * `edit_file`, which change it; and `run_command`, which runs a shell command in it. Each tool is its catalog entry (what the model is offered, with its kind, which
 * a permission policy reads) and the function that runs it, defined together, so a tool offered is
 * a tool that runs. `workspaceTools(root)` gives the catalog, for a session's opening, and the
 * `ToolRunner` that runs a call.
 *
 * A path is relative to the root, or absolute; one that is not inside the root is not accepted.
 * `read_file` reads UTF-8 text, at most 256 KiB in one result; `line` (1-based) and `limit` (a
 * count of lines) read part of a file. `list_dir` lists one folder, without recursion, a folder's
 * name followed by `/`. `write_file` creates or replaces a file with at most 256 KiB of text; the
 * folder it is in must exist. A call left with no outcome when its process ended runs when the
 * session goes on only for `read_file` and `list_dir`, which change nothing (`replay: "safe"`).
 * `write_file` does not: it writes the same text whenever it runs, but the file may have changed
 * since (`"idempotent"`). `edit_file` replaces the one occurrence of a text in a file; text that
 * occurs never or more than once is refused. `run_command` runs `sh -c <command>` in the root, and
 * gives its output (stdout, then stderr; the last 256 KiB, kept as it is read) and how it ended:
 * exit code 0 succeeds, any other end fails with the output. It runs as a process group of its own,
 * stopped whole, what it started included, after its time (`commandSeconds` unless the call says,
 * at most 600 seconds) or when the call is interrupted; a command that ends by itself leaves what
 * it started in the background to run on. Neither runs again when a
 * session goes on (`"unsafe"`).
 *
 * A call that cannot run fails with the reason: no tool has the name (`NotFound`), the input does
 * not fit (`InputRejected`), or the file system reported an error (`Reported`, with its message).
 */

import { isAbsolute, relative, resolve } from "node:path";
import { Data, Duration, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { FailureText, ToolName } from "../agent-machine/names.ts";
import type { ToolOutcome } from "../agent-machine/observation.ts";
import { ToolRunner, type ToolSpec } from "../agent-session/contracts.ts";
import { decoderOf, jsonSchemaOf } from "../agent-session/tool-input.ts";
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
const EditFile = Schema.Struct({ path: Schema.NonEmptyString, old_text: Schema.NonEmptyString, new_text: Schema.String });
const RunCommand = Schema.Struct({
  command: Schema.NonEmptyString,
  timeout_seconds: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(600))),
});

/** How long a command runs before it is stopped, unless the call says otherwise. */
export const commandSeconds = 120;

/**
 * What `stream` gives, read to its end keeping only its last `max` bytes or so: a command's output is
 * cut to its tail while it is read, not after.
 */
const tailOf = async (stream: ReadableStream<Uint8Array>, max: number): Promise<{ readonly text: string; readonly cut: boolean }> => {
  const chunks: Array<Uint8Array> = [];
  let held = 0;
  let dropped = false;
  for await (const chunk of stream) {
    chunks.push(chunk);
    held += chunk.byteLength;
    while (chunks.length > 1 && held - (chunks[0]?.byteLength ?? 0) >= max) {
      held -= chunks.shift()?.byteLength ?? 0;
      dropped = true;
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), cut: dropped };
};

/** The last `max` bytes of `text`, never inside a character, and whether any were left out. */
const lastBytes = (text: string, max: number): { readonly kept: string; readonly cut: boolean } => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { kept: text, cut: false };
  let start = bytes.length - max;
  // A continuation byte (10xxxxxx) is inside a character: step on to the next character's first byte.
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return { kept: bytes.subarray(start).toString("utf8"), cut: true };
};

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
      input: jsonSchemaOf(ReadFile),
      decode: decoderOf(ReadFile),
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
      input: jsonSchemaOf(ListDir),
      decode: decoderOf(ListDir),
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
      input: jsonSchemaOf(WriteFile),
      decode: decoderOf(WriteFile),
      run: ({ path, text }) =>
        Effect.gen(function* () {
          const full = yield* inside(path);
          const bytes = Buffer.byteLength(text);
          if (bytes > maxReadBytes) return yield* new Rejected({ problem: `The text is over 256 KiB (${bytes} bytes). Write less.` });
          yield* (yield* FileSystem.FileSystem).writeFileString(full, text).pipe(Effect.mapError(reported(path)));
          return `Wrote ${bytes} bytes to ${path}.`;
        }),
    } satisfies WorkspaceTool<typeof WriteFile.Type>),
    tool({
      name: ToolName.make("edit_file"),
      kind: "edit",
      replay: "unsafe",
      description: `Replace one occurrence of old_text in a UTF-8 file in the workspace with new_text. old_text must occur exactly once: include enough of the lines around it to make it so.${scope}`,
      input: jsonSchemaOf(EditFile),
      decode: decoderOf(EditFile),
      run: ({ path, old_text, new_text }) =>
        Effect.gen(function* () {
          const full = yield* inside(path);
          const fs = yield* FileSystem.FileSystem;
          const text = yield* fs.readFileString(full).pipe(Effect.mapError(reported(path)));
          const count = text.split(old_text).length - 1;
          if (count !== 1)
            return yield* new Rejected({
              problem: count === 0 ? `old_text does not occur in ${path}.` : `old_text occurs ${count} times in ${path}; include more of the lines around it so that it occurs once.`,
            });
          const changed = text.replace(old_text, () => new_text);
          const bytes = Buffer.byteLength(changed);
          if (bytes > maxReadBytes) return yield* new Rejected({ problem: `The file would be over 256 KiB (${bytes} bytes).` });
          yield* fs.writeFileString(full, changed).pipe(Effect.mapError(reported(path)));
          return `Edited ${path}.`;
        }),
    } satisfies WorkspaceTool<typeof EditFile.Type>),
    tool({
      name: ToolName.make("run_command"),
      kind: "execute",
      replay: "unsafe",
      description: `Run a shell command (sh -c) in the workspace, and get its output (stdout, then stderr; the last 256 KiB) and how it exited. It is stopped after timeout_seconds (${commandSeconds} unless given; at most 600). Use it to search files (grep, find), run tests and use git.${scope}`,
      input: jsonSchemaOf(RunCommand),
      decode: decoderOf(RunCommand),
      run: ({ command, timeout_seconds }) => {
        const seconds = timeout_seconds ?? commandSeconds;
        // The command is a process group of its own (`detached`). Stopped (at its time, or when the
        // call is interrupted), the whole group is killed, what it started included; a command that
        // ends by itself leaves what it started to run on (`nohup server &`).
        return Effect.acquireUseRelease(
          Effect.sync(() => Bun.spawn(["/bin/sh", "-c", command], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true })),
          (child) =>
            Effect.promise(() => Promise.all([tailOf(child.stdout, maxReadBytes), tailOf(child.stderr, maxReadBytes), child.exited])).pipe(
              Effect.timeoutOption(Duration.seconds(seconds)),
            ),
          (child, exit) =>
            Effect.sync(() => {
              if (exit._tag === "Success" && Option.isSome(exit.value)) return;
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                // The group has ended already.
              }
            }),
        ).pipe(
          Effect.flatMap((ended) => {
            if (Option.isNone(ended)) return Effect.fail(new Reported({ message: `[Still running after ${seconds} seconds: stopped.]` }));
            const [out, err, code] = ended.value;
            const [stdout, stderr] = [out.text, err.text];
            const output = `${stdout}${stdout !== "" && stderr !== "" && !stdout.endsWith("\n") ? "\n" : ""}${stderr}`;
            const last = lastBytes(output, maxReadBytes);
            const [kept, cut] = [last.kept, last.cut || out.cut || err.cut];
            const text = `${cut ? "[The output's beginning was cut: its last 256 KiB follow.]\n" : ""}${kept}${kept === "" || kept.endsWith("\n") ? "" : "\n"}[Exit code ${code}.]`;
            return code === 0 ? Effect.succeed(text) : Effect.fail(new Reported({ message: text }));
          }),
        );
      },
    } satisfies WorkspaceTool<typeof RunCommand.Type>),
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
