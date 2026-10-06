/**
 * Tools for a workspace, a folder on disk: `read_file` and `list_dir`, which read; `write_file` and
 * `edit_file`, which change it; and `run_command`, which runs a shell command in it. Each tool is its
 * catalog entry (what the model is offered, with its kind, which a permission policy reads) and the
 * function that runs it, defined together, so a tool offered is a tool that runs.
 * `workspaceTools(root)` returns the catalog, the tool source (`ToolSource`, the host's own tools,
 * with no namespace) that runs a call given the file system, and the system text that names the
 * root as the working folder.
 *
 * A tool's description states what the tool does and its limits; each input's description states
 * what the input means, whether it is optional, and its default. The descriptions call the root "the
 * working folder" and do not name it: the host sends the system text (`workingFolderLine`) that
 * names it once.
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
 * stopped whole, what it started included, after its time (`commandSeconds` unless the call says, at most
 * `maxCommandSeconds`) or when the call is interrupted; a command that ends by itself leaves what
 * it started in the background to run on. Neither runs again when a
 * session goes on (`"unsafe"`).
 *
 * A call that cannot run fails with the reason: no tool has the name (`NotFound`), the input does
 * not fit (`InputRejected`), or the file system reported an error (`Reported`, with its message).
 */

import { isAbsolute, relative, resolve } from "node:path";
import { Array as Arr, Chunk, Data, Duration, Effect, FileSystem, Option, Order, Schema, Stream } from "effect";
import { FailureText, ToolName } from "../agent-machine/names.ts";
import type { ToolOutcome } from "../agent-machine/observation.ts";
import type { ToolSpec } from "../agent-session/contracts.ts";
import type { ToolSource } from "../agent-session/tool-sources.ts";
import { type Environment, withoutCredentials } from "../agent-process/environment.ts";
import { type Decoded, decoderOf, ignoredNote, jsonSchemaOf } from "../agent-session/tool-input.ts";
import { logKeys } from "../agent-session/log-keys.ts";
import { parseJson, receivedText } from "../agent-session/received.ts";

/** The most bytes `read_file` returns in one result, `write_file` writes, and `run_command` returns. */
export const maxReadBytes = 256 * 1024;

/** `maxReadBytes` as the tool descriptions state it. */
export const maxReadText = `${maxReadBytes / 1024} KiB`;

/** How long a command runs before it is stopped, unless the call says otherwise. */
export const commandSeconds = 120;

/** The longest time that a call can give a command. */
export const maxCommandSeconds = 600;

/**
 * The system text that names the working folder. The tool descriptions refer to "the working folder"
 * without naming it, so a host that offers these tools sends this text as well.
 */
export const workingFolderLine = (folder: string): string => `The working folder is ${folder}.`;

/** A path input of a tool that reads or changes one file. */
export const filePath = Schema.NonEmptyString.annotate({ description: "The file's path: relative to the working folder, or absolute inside it." });

export const ReadFile = Schema.Struct({
  path: filePath,
  line: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Optional: the first line to read, 1-based. Default: 1." })),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Optional: the number of lines to read. Default: to the end of the file." })),
});
const ListDir = Schema.Struct({
  path: Schema.NonEmptyString.annotate({ description: 'The folder\'s path: relative to the working folder, or absolute inside it. "." is the working folder.' }),
});
const WriteFile = Schema.Struct({ path: filePath, text: Schema.String.annotate({ description: `The file's new text, at most ${maxReadText}.` }) });
export const EditFile = Schema.Struct({
  path: filePath,
  old_text: Schema.NonEmptyString.annotate({ description: "The text to replace. It must occur exactly once in the file: include enough of the lines around it to make it so." }),
  new_text: Schema.String.annotate({ description: "The text to put in its place." }),
});
export const RunCommand = Schema.Struct({
  command: Schema.NonEmptyString.annotate({ description: "The command, run with sh -c." }),
  timeout_seconds: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(maxCommandSeconds))
      .annotate({ description: `Optional: the number of seconds after which the command is stopped, at most ${maxCommandSeconds}. Default: ${commandSeconds}.` }),
  ),
});

/** The end of a stream read so far: its newest chunks, how many bytes they hold, and whether older chunks were dropped. */
interface Tail {
  readonly chunks: Chunk.Chunk<Uint8Array>;
  readonly held: number;
  readonly cut: boolean;
}

const noTail: Tail = { chunks: Chunk.empty(), held: 0, cut: false };

/** `tail` without its oldest chunks, dropped one at a time while the newer chunks still hold at least `max` bytes. */
const dropOldest = (tail: Tail, max: number): Tail => {
  const oldest = Chunk.head(tail.chunks);
  if (Option.isNone(oldest) || Chunk.size(tail.chunks) < 2 || tail.held - oldest.value.byteLength < max) return tail;
  return dropOldest({ chunks: Chunk.drop(tail.chunks, 1), held: tail.held - oldest.value.byteLength, cut: true }, max);
};

/**
 * Reads `stream` to its end and returns about its last `max` bytes as text, and whether older bytes
 * were dropped. The output is cut to its tail while it is read, so a long output is never held whole.
 */
const tailOf = (stream: ReadableStream<Uint8Array>, max: number): Effect.Effect<{ readonly text: string; readonly cut: boolean }> =>
  Stream.fromReadableStream({ evaluate: () => stream, onError: (cause) => cause }).pipe(
    Stream.runFold(
      () => noTail,
      (tail, chunk: Uint8Array) => dropOldest({ chunks: Chunk.append(tail.chunks, chunk), held: tail.held + chunk.byteLength, cut: tail.cut }, max),
    ),
    Effect.map((tail) => ({ text: Buffer.concat(Chunk.toReadonlyArray(tail.chunks)).toString("utf8"), cut: tail.cut })),
    // A pipe that cannot be read is a defect, as it was when the stream was read with a loop.
    Effect.orDie,
  );

/** Whether `byte` is a UTF-8 continuation byte (10xxxxxx): one inside a character, not its first. */
const continues = (byte: number): boolean => (byte & 0xc0) === 0x80;

/**
 * Returns the last `max` bytes of `text`, and whether any bytes were dropped. When the cut would fall
 * inside a character, the kept text starts at the next character.
 */
const lastBytes = (text: string, max: number): { readonly kept: string; readonly cut: boolean } => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { kept: text, cut: false };
  const from = bytes.length - max;
  const characterStart = bytes.subarray(from).findIndex((byte) => !continues(byte));
  return { kept: bytes.subarray(characterStart === -1 ? bytes.length : from + characterStart).toString("utf8"), cut: true };
};

interface WorkspaceTool<I> extends ToolSpec {
  readonly decode: (input: unknown) => Effect.Effect<Decoded<I>, Schema.SchemaError>;
  readonly run: (input: I) => Effect.Effect<string, Rejected | Reported, FileSystem.FileSystem>;
}

/** The input names a path outside the workspace, or otherwise does not fit. */
class Rejected extends Data.TaggedError("Rejected")<{ readonly problem: string }> {}
/** The file system reported an error. */
class Reported extends Data.TaggedError("Reported")<{ readonly message: string }> {}

const tool = <I>(definition: WorkspaceTool<I>): WorkspaceTool<unknown> => definition as unknown as WorkspaceTool<unknown>;

/**
 * The workspace tools for the folder `root`. With `strictInput`, a call whose input has properties
 * its tool does not take is refused; without (the default), it runs without them, and its result
 * says which were ignored.
 */
export function workspaceTools(root: string, options: { readonly strictInput?: boolean; readonly environment?: Environment } = {}) {
  const strict = options.strictInput ?? false;
  // What `run_command` is given: what the host composed (`commandEnvironment`), else this process's without its credentials.
  const environment = options.environment ?? withoutCredentials(process.env).env;
  const inside = (path: string) => {
    const full = resolve(root, path);
    const from = relative(root, full);
    return from.startsWith("..") || isAbsolute(from)
      ? Effect.fail(new Rejected({ problem: `${path} is not inside the workspace, ${root}.` }))
      : Effect.succeed(full);
  };
  const reported = (path: string) => (error: { readonly message: string }) => new Reported({ message: `${path}: ${error.message}` });

  const tools: ReadonlyArray<WorkspaceTool<unknown>> = [
    tool({
      name: ToolName.make("read_file"),
      kind: "read",
      replay: "safe",
      description: `Read a UTF-8 text file in the working folder. A result is at most ${maxReadText}: read a larger file in parts with line and limit. If the file does not exist, list its folder with list_dir.`,
      input: jsonSchemaOf(ReadFile),
      decode: decoderOf(ReadFile, strict),
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
          return yield* new Rejected({ problem: `The result is over ${maxReadText}. Read fewer lines: ${JSON.stringify(fewer)}.` });
        }),
    } satisfies WorkspaceTool<typeof ReadFile.Type>),
    tool({
      name: ToolName.make("list_dir"),
      kind: "search",
      replay: "safe",
      description: "List the files and folders in one folder of the working folder, without recursion. A folder's name ends with /.",
      input: jsonSchemaOf(ListDir),
      decode: decoderOf(ListDir, strict),
      run: ({ path }) =>
        Effect.gen(function* () {
          const full = yield* inside(path);
          const fs = yield* FileSystem.FileSystem;
          const names = yield* fs.readDirectory(full).pipe(Effect.mapError(reported(path)));
          const listed = yield* Effect.forEach(Arr.sort(names, Order.String), (name) =>
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
      description: "Create a UTF-8 text file in the working folder, or replace one. The file's folder must exist.",
      input: jsonSchemaOf(WriteFile),
      decode: decoderOf(WriteFile, strict),
      run: ({ path, text }) =>
        Effect.gen(function* () {
          const full = yield* inside(path);
          const bytes = Buffer.byteLength(text);
          if (bytes > maxReadBytes) return yield* new Rejected({ problem: `The text is over ${maxReadText} (${bytes} bytes). Write less.` });
          yield* (yield* FileSystem.FileSystem).writeFileString(full, text).pipe(Effect.mapError(reported(path)));
          return `Wrote ${bytes} bytes to ${path}.`;
        }),
    } satisfies WorkspaceTool<typeof WriteFile.Type>),
    tool({
      name: ToolName.make("edit_file"),
      kind: "edit",
      replay: "unsafe",
      description: "Replace one occurrence of old_text with new_text in a UTF-8 text file in the working folder.",
      input: jsonSchemaOf(EditFile),
      decode: decoderOf(EditFile, strict),
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
          if (bytes > maxReadBytes) return yield* new Rejected({ problem: `The file would be over ${maxReadText} (${bytes} bytes).` });
          yield* fs.writeFileString(full, changed).pipe(Effect.mapError(reported(path)));
          return `Edited ${path}.`;
        }),
    } satisfies WorkspaceTool<typeof EditFile.Type>),
    tool({
      name: ToolName.make("run_command"),
      kind: "execute",
      replay: "unsafe",
      description: `Run a shell command in the working folder. The result is its output (stdout, then stderr) and its exit code; an output over ${maxReadText} is cut to its last ${maxReadText}. Use it to search files (grep, find), run tests and use git.`,
      input: jsonSchemaOf(RunCommand),
      decode: decoderOf(RunCommand, strict),
      run: ({ command, timeout_seconds }) => {
        const seconds = timeout_seconds ?? commandSeconds;
        // The command is a process group of its own (`detached`). Stopped (at its time, or when the
        // call is interrupted), the whole group is killed, what it started included; a command that
        // ends by itself leaves what it started to run on (`nohup server &`). It is given the
        // environment the host composed, by default without this process's credentials
        // (agent-process `environment.ts`): what it prints the model reads.
        return Effect.acquireUseRelease(
          Effect.sync(() =>
            Bun.spawn(["/bin/sh", "-c", command], { cwd: root, env: { ...environment }, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true }),
          ),
          (child) =>
            Effect.all([tailOf(child.stdout, maxReadBytes), tailOf(child.stderr, maxReadBytes), Effect.promise(() => child.exited)], { concurrency: "unbounded" }).pipe(
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
            const text = `${cut ? `[The output's beginning was cut: its last ${maxReadText} follow.]\n` : ""}${kept}${kept === "" || kept.endsWith("\n") ? "" : "\n"}[Exit code ${code}.]`;
            return code === 0 ? Effect.succeed(text) : Effect.fail(new Reported({ message: text }));
          }),
        );
      },
    } satisfies WorkspaceTool<typeof RunCommand.Type>),
  ];

  const catalog: ReadonlyArray<ToolSpec> = tools.map(({ name, description, input, kind, replay }) => ({ name, description, input, kind, replay }));

  const rejected = (problem: string): ToolOutcome => ({ _tag: "Failed", reason: { _tag: "InputRejected", problem: FailureText.make(problem) } });

  /** Runs the tool a call names on its input, with the file system it is given. */
  const source: Effect.Effect<ToolSource, never, FileSystem.FileSystem> = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return {
      tools: catalog,
      run: (name, input) => {
        const found = tools.find((each) => each.name === name);
        if (found === undefined) return Effect.succeed<ToolOutcome>({ _tag: "Failed", reason: { _tag: "NotFound" } });
        const parsed = parseJson(input);
        if ("reason" in parsed) return Effect.succeed(rejected(`The input could not be read: ${parsed.reason}.`));
        return found.decode(parsed.value).pipe(
          Effect.mapError((error) => new Rejected({ problem: `${name} does not take this input: ${error.message}` })),
          Effect.flatMap(({ value, ignored }) => {
            const note = ignoredNote(name, ignored);
            const logged = ignored.length === 0 ? Effect.void : Effect.logWarning(logKeys.tools.inputIgnored, { tool: name, ignored });
            return logged.pipe(
              Effect.andThen(found.run(value)),
              Effect.map((output): ToolOutcome => ({ _tag: "Succeeded", output: receivedText(`${output}${note}`) })),
              Effect.catchTag("Reported", (error) => Effect.fail(new Reported({ message: `${error.message}${note}` }))),
            );
          }),
          Effect.catchTags({
            Rejected: (error) => Effect.succeed(rejected(error.problem)),
            Reported: (error) => Effect.succeed<ToolOutcome>({ _tag: "Failed", reason: { _tag: "Reported", error: receivedText(error.message) } }),
          }),
          Effect.provideService(FileSystem.FileSystem, fs),
        );
      },
    };
  });

  return { catalog, source, environment, system: workingFolderLine(root) };
}
