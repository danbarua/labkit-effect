/**
 * The workspace tools: `read_file` and `list_dir`, which read; `write_file` and `edit_file`, which
 * change files; and `run_command`, which runs a shell command in the working folder.
 *
 * The file tools are primitives (`tool.ts`): each takes a path as it is given, absolute or relative
 * to the process's working folder, and checks nothing about where it is. `workspaceTools(root)`
 * applies two wrappers:
 * - `inWorkspace(root)` (`in-workspace.ts`) wraps the file tools: it resolves their paths against the
 *   root; the permission policy judges a path outside it.
 * - `described` (`described.ts`) wraps every tool: it adds a required `intent` input.
 *
 * `workspaceTools(root)` returns the catalog, the tool source that runs a call given the file
 * system and the session's context, and the system text that names the root as the working folder
 * (`workingFolderLine`). The descriptions call the root "the working folder" and
 * do not name it. A tool's description states what the tool does and its limits; each input's
 * description states what the input means, whether it is optional, and its default.
 *
 * `read_file` reads UTF-8 text, at most 256 KiB in one result; `line` (1-based) and `limit` (a
 * count of lines) read part of a file. `list_dir` lists one folder, without recursion, a folder's
 * name followed by `/`. `write_file` creates or replaces a file with at most 256 KiB of text; the
 * folder it is in must exist. A call left with no outcome when its process ended runs when the
 * session goes on only for `read_file` and `list_dir`, which change nothing (`replay: "safe"`).
 * `write_file` does not: it writes the same text whenever it runs, but the file may have changed
 * since (`"idempotent"`). `edit_file` replaces the one occurrence of a text in a file; text that
 * occurs never or more than once is refused. `run_command` runs `sh -c <command>` in the root, and
 * gives its output (stdout, then stderr; the last 256 KiB, kept as it is read) and how it ended:
 * exit code 0 succeeds, any other end fails with the output. It runs with the session's environment
 * (`SessionContext.environment`), read when the call runs. It runs as a process group of its own,
 * stopped whole, what it started included, after its time (`commandSeconds` unless the call says,
 * at most `maxCommandSeconds`) or when the call is interrupted; a command that ends by itself leaves
 * what it started in the background to run on. Neither runs again when a session goes on
 * (`"unsafe"`).
 *
 * A call that cannot run fails with the reason: no tool has the name (`NotFound`), the input does
 * not fit (`InputRejected`), or the file system reported an error (`Reported`, with its message).
 */

import { resolve } from "node:path";
import { Array as Arr, Chunk, Duration, Effect, FileSystem, Option, Order, Schema, Stream } from "effect";
import { SessionContext } from "../agent-environment/session-context.ts";
import { ToolName } from "../agent-machine/names.ts";
import { described } from "./described.ts";
import { inWorkspace } from "./in-workspace.ts";
import { blobReads } from "./blob-reads.ts";
import { maxReadBytes, maxReadText, selectedLines } from "./read-limits.ts";
import { FilePath, FolderPath } from "./paths.ts";
import { type AnyTool, anyTool, Rejected, Reported, sourceOf, type Tool } from "./tool.ts";


export { maxReadBytes, maxReadText } from "./read-limits.ts";

/** How long a command runs before it is stopped, unless the call says otherwise. */
export const commandSeconds = 120;

/** The longest time that a call can give a command. */
export const maxCommandSeconds = 600;

/**
 * The system text that names the working folder. The tool descriptions refer to "the working folder"
 * without naming it, so a host that offers these tools sends this text as well.
 */
export const workingFolderLine = (folder: string, additional: ReadonlyArray<string> = []): string =>
  `The working folder is ${folder}.${additional.length === 0 ? "" : ` These folders count as inside it too: ${additional.join(", ")}.`}`;

export const ReadFile = Schema.Struct({
  path: FilePath,
  line: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Optional: the first line to read, 1-based. Default: 1." })),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Optional: the number of lines to read. Default: to the end of the file." })),
});
const ListDir = Schema.Struct({ path: FolderPath });
const WriteFile = Schema.Struct({ path: FilePath, text: Schema.String.annotate({ description: `The file's new text, at most ${maxReadText}.` }) });
export const EditFile = Schema.Struct({
  path: FilePath,
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

/** Returns the failure of a file system operation on `path`, with the file system's message. */
const reported = (path: string) => (error: { readonly message: string }) => new Reported({ message: `${path}: ${error.message}` });

/** `read_file`: reads a UTF-8 file, or the lines that `line` and `limit` select. */
export const readFile: Tool<typeof ReadFile.fields, FileSystem.FileSystem> = {
  name: ToolName.make("read_file"),
  kind: "read",
  replay: "safe",
  description: `Read a UTF-8 text file. A result is at most ${maxReadText}: read a larger file in parts with line and limit. If the file does not exist, list its folder with list_dir.`,
  input: ReadFile,
  run: ({ path, line, limit }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(path).pipe(Effect.mapError(reported(path)));
      return yield* selectedLines(text, line, limit);
    }),
};

/** `list_dir`: lists one folder, without recursion. */
export const listDir: Tool<typeof ListDir.fields, FileSystem.FileSystem> = {
  name: ToolName.make("list_dir"),
  kind: "search",
  replay: "safe",
  description: "List the files and folders in one folder, without recursion. A folder's name ends with /.",
  input: ListDir,
  run: ({ path }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const names = yield* fs.readDirectory(path).pipe(Effect.mapError(reported(path)));
      const listed = yield* Effect.forEach(Arr.sort(names, Order.String), (name) =>
        fs.stat(resolve(path, name)).pipe(
          Effect.map((info) => (info.type === "Directory" ? `${name}/` : name)),
          Effect.mapError(reported(`${path}/${name}`)),
        ),
      );
      return listed.join("\n");
    }),
};

/** `write_file`: creates or replaces a file. */
export const writeFile: Tool<typeof WriteFile.fields, FileSystem.FileSystem> = {
  name: ToolName.make("write_file"),
  kind: "edit",
  replay: "idempotent",
  description: "Create a UTF-8 text file, or replace one. The file's folder must exist.",
  input: WriteFile,
  run: ({ path, text }) =>
    Effect.gen(function* () {
      const bytes = Buffer.byteLength(text);
      if (bytes > maxReadBytes) return yield* new Rejected({ problem: `The text is over ${maxReadText} (${bytes} bytes). Write less.` });
      yield* (yield* FileSystem.FileSystem).writeFileString(path, text).pipe(Effect.mapError(reported(path)));
      return `Wrote ${bytes} bytes to ${path}.`;
    }),
};

/** `edit_file`: replaces the one occurrence of a text in a file. */
export const editFile: Tool<typeof EditFile.fields, FileSystem.FileSystem> = {
  name: ToolName.make("edit_file"),
  kind: "edit",
  replay: "unsafe",
  description: "Replace one occurrence of old_text with new_text in a UTF-8 text file.",
  input: EditFile,
  run: ({ path, old_text, new_text }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(path).pipe(Effect.mapError(reported(path)));
      const count = text.split(old_text).length - 1;
      if (count !== 1)
        return yield* new Rejected({
          problem: count === 0 ? `old_text does not occur in ${path}.` : `old_text occurs ${count} times in ${path}; include more of the lines around it so that it occurs once.`,
        });
      const changed = text.replace(old_text, () => new_text);
      const bytes = Buffer.byteLength(changed);
      if (bytes > maxReadBytes) return yield* new Rejected({ problem: `The file would be over ${maxReadText} (${bytes} bytes).` });
      yield* fs.writeFileString(path, changed).pipe(Effect.mapError(reported(path)));
      return `Edited ${path}.`;
    }),
};

/** `run_command`: runs a shell command in the folder `root`, with the session's environment. */
export const runCommand = (root: string): Tool<typeof RunCommand.fields, SessionContext> => ({
  name: ToolName.make("run_command"),
  kind: "execute",
  replay: "unsafe",
  description: `Run a shell command in the working folder. The result is its output (stdout, then stderr) and its exit code; an output over ${maxReadText} is cut to its last ${maxReadText}. Use it to search files (grep, find) and run tests.`,
  input: RunCommand,
  run: ({ command, timeout_seconds }) => {
    const seconds = timeout_seconds ?? commandSeconds;
    // The command is a process group of its own (`detached`). Stopped (at its time, or when the
    // call is interrupted), the whole group is killed, what it started included; a command that
    // ends by itself leaves what it started to run on (`nohup server &`). It is given the session's
    // environment (`SessionContext.environment`), which the host made from the configuration's
    // `commandEnvironment`, by default without this process's credentials: what it prints the model reads.
    return Effect.acquireUseRelease(
      Effect.flatMap(SessionContext, ({ environment }) =>
        Effect.sync(() =>
          Bun.spawn(["/bin/sh", "-c", command], { cwd: root, env: { ...environment.variables }, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true }),
        ),
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
});

/**
 * The workspace tools for the folder `root`. With `strictInput`, a call whose input has properties
 * its tool does not take is refused; without (the default), it runs without them, and its result
 * says which were ignored. A host records what the tools change in files (`agent-host/recorded-changes.ts`).
 */
export function workspaceTools(
  root: string,
  options: {
    readonly strictInput?: boolean;
    readonly additional?: ReadonlyArray<string>;
  } = {},
) {
  const additional = options.additional ?? [];
  const bound = inWorkspace(root);
  const tools: ReadonlyArray<AnyTool<FileSystem.FileSystem | SessionContext>> = [
    anyTool(described(blobReads(bound(readFile)))),
    anyTool(described(bound(listDir))),
    anyTool(described(bound(writeFile))),
    anyTool(described(bound(editFile))),
    anyTool(described(runCommand(root))),
  ];
  return {
    catalog: tools.map((tool) => tool.spec),
    source: sourceOf(tools, { strictInput: options.strictInput ?? false }),
    system: workingFolderLine(root, additional),
  };
}
