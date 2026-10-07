/**
 * The tools that go through the editor, ACP's client: `read_file` with `fs/read_text_file`,
 * `write_file` with `fs/write_text_file`, `edit_file` with both, `terminal_command` in a terminal of the
 * editor's (`terminal/*`), and `update_plan`, which sends the model's plan to the editor (a `plan`
 * update). Each is a primitive tool (`agent-tools/tool.ts`) that asks for the `Editor` service: the
 * editor is the environment the tools run in, and the world provides it. A file tool takes the path
 * as it is given; `inWorkspace` resolves the model's paths against the working folder first.
 *
 * - `read_file` reads the file as the editor has it, unsaved changes included. A result over 256 KiB
 *   is cut there, with a note that says how many bytes were left out.
 * - `terminal_command` waits for the command's exit until its time runs out, reads its output (the last
 *   256 KiB), and releases the terminal however the call ends, which stops a command still running.
 *   The terminal is shown in the call (`CurrentCall`) from when it is made.
 * - A failure the editor reports is the call's failure, naming the method and the path or command.
 */

import { Context, Duration, Effect, HashMap, Option, Ref, Schema } from "effect";
import type { AgentConnection } from "effective-acp/agent";
import type { V1Version } from "effective-acp/protocol";
import { type SessionId, type TerminalId, ToolCallId } from "effective-acp/schema/v1";
import { type CallId, ToolName } from "../agent-machine/names.ts";
import { FilePath } from "../agent-tools/paths.ts";
import { CurrentCall, Reported, Rejected, type Tool } from "../agent-tools/tool.ts";
import { commandSeconds, EditFile, maxReadBytes, maxReadText, ReadFile, RunCommand } from "../agent-tools/workspace.ts";

/** The editor that a session's tools go through. */
export class Editor extends Context.Service<
  Editor,
  {
    readonly connection: AgentConnection<V1Version>;
    readonly sessionId: SessionId;
    /** The working folder, where a command's terminal starts. */
    readonly cwd: string;
    /** The terminal each command ran in, by call: shown in the call as it runs, and when it has ended. */
    readonly terminals: Ref.Ref<HashMap.HashMap<CallId, TerminalId>>;
  }
>()("agent-acp/Editor") {}

const WriteFile = Schema.Struct({ path: FilePath, content: Schema.String.annotate({ description: `The file's new text, at most ${maxReadText}.` }) });

const PlanEntryInput = Schema.Struct({
  content: Schema.NonEmptyString.annotate({ description: "What the step does." }),
  status: Schema.Literals(["pending", "in_progress", "completed"]).annotate({ description: "The step's status. Keep one step in_progress while you work on it." }),
  priority: Schema.optionalKey(Schema.Literals(["high", "medium", "low"]).annotate({ description: "Optional: the step's priority. Default: medium." })),
});
const UpdatePlan = Schema.Struct({
  entries: Schema.Array(PlanEntryInput).annotate({ description: "Every step of the plan, in order. Send the whole list each time it changes." }),
});

/** Returns the failure of a call to the editor's `method` about `about` (a path or a command), for the model to read. */
const failed =
  (method: string, about: string) =>
  (error: { readonly _tag?: string; readonly message?: string; readonly reason?: string }): Reported =>
    new Reported({
      message: `${method} ${about}: ${error._tag === "PeerClosed" ? `the editor's connection closed (${error.reason ?? ""})` : (error.message ?? error._tag ?? "the editor gave no reason")}`,
    });

/** Returns `at`, or, when the byte there is inside a character (a continuation byte, 10xxxxxx), the position of the character's first byte. */
const characterStart = (bytes: Uint8Array, at: number): number => (at > 0 && ((bytes[at] ?? 0) & 0xc0) === 0x80 ? characterStart(bytes, at - 1) : at);

/** Returns `text` cut to at most `max` bytes of UTF-8, never inside a character, and how many bytes were cut. */
const cut = (text: string, max: number): { readonly kept: string; readonly omitted: number } => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { kept: text, omitted: 0 };
  const end = characterStart(bytes, max);
  return { kept: bytes.subarray(0, end).toString("utf8"), omitted: bytes.length - end };
};

/** `read_file`: reads a file as the editor has it, or the lines that `line` and `limit` select. */
export const readFile: Tool<typeof ReadFile.fields, Editor> = {
  name: ToolName.make("read_file"),
  kind: "read",
  replay: "safe",
  description: `Read a UTF-8 text file as the editor has it, unsaved changes included. A result is at most ${maxReadText}: read a larger file in parts with line and limit.`,
  input: ReadFile,
  run: (input) =>
    Effect.gen(function* () {
      const { connection, sessionId } = yield* Editor;
      const { content } = yield* connection.client["fs/read_text_file"]({
        sessionId,
        path: input.path,
        ...(input.line === undefined ? {} : { line: input.line }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }).pipe(Effect.mapError(failed("fs/read_text_file", input.path)));
      const { kept, omitted } = cut(content, maxReadBytes);
      return omitted === 0 ? kept : `${kept}\n[Cut at ${maxReadText}: ${omitted} bytes left out. Read the rest with line and limit.]`;
    }),
};

/** `write_file`: creates or replaces a file through the editor. */
export const writeFile: Tool<typeof WriteFile.fields, Editor> = {
  name: ToolName.make("write_file"),
  kind: "edit",
  replay: "idempotent",
  description: "Create a UTF-8 text file, or replace one, through the editor.",
  input: WriteFile,
  run: (input) =>
    Effect.gen(function* () {
      const bytes = Buffer.byteLength(input.content);
      if (bytes > maxReadBytes) return yield* new Rejected({ problem: `The content is over ${maxReadText} (${bytes} bytes). Write less.` });
      const { connection, sessionId } = yield* Editor;
      yield* connection.client["fs/write_text_file"]({ sessionId, path: input.path, content: input.content }).pipe(Effect.mapError(failed("fs/write_text_file", input.path)));
      return `Wrote ${bytes} bytes to ${input.path}.`;
    }),
};

/** `edit_file`: replaces the one occurrence of a text in a file, as the editor has it. */
export const editFile: Tool<typeof EditFile.fields, Editor> = {
  name: ToolName.make("edit_file"),
  kind: "edit",
  replay: "unsafe",
  description: "Replace one occurrence of old_text with new_text in a UTF-8 text file, through the editor, its unsaved changes included.",
  input: EditFile,
  run: (input) =>
    Effect.gen(function* () {
      const { connection, sessionId } = yield* Editor;
      const { content } = yield* connection.client["fs/read_text_file"]({ sessionId, path: input.path }).pipe(Effect.mapError(failed("edit_file", input.path)));
      const count = content.split(input.old_text).length - 1;
      if (count !== 1)
        return yield* new Rejected({
          problem: count === 0 ? `old_text does not occur in ${input.path}.` : `old_text occurs ${count} times in ${input.path}; include more of the lines around it so that it occurs once.`,
        });
      const changed = content.replace(input.old_text, () => input.new_text);
      const bytes = Buffer.byteLength(changed);
      if (bytes > maxReadBytes) return yield* new Rejected({ problem: `The file would be over ${maxReadText} (${bytes} bytes).` });
      yield* connection.client["fs/write_text_file"]({ sessionId, path: input.path, content: changed }).pipe(Effect.mapError(failed("edit_file", input.path)));
      return `Edited ${input.path}.`;
    }),
};

/** `update_plan`: sends the model's plan to the editor. */
export const updatePlan: Tool<typeof UpdatePlan.fields, Editor> = {
  name: ToolName.make("update_plan"),
  kind: "think",
  replay: "safe",
  description: "Record your plan for the task as a list of steps. The user sees the plan in the editor.",
  input: UpdatePlan,
  run: (input) =>
    Effect.gen(function* () {
      const { connection, sessionId } = yield* Editor;
      const entries = input.entries.map((entry) => ({ content: entry.content, status: entry.status, priority: entry.priority ?? "medium" }));
      const count = (status: string) => entries.filter((entry) => entry.status === status).length;
      yield* connection.notify("session/update", { sessionId, update: { sessionUpdate: "plan", entries } }).pipe(Effect.mapError(failed("update_plan", "the plan")));
      return `The plan has ${entries.length} steps: ${count("completed")} completed, ${count("in_progress")} in progress, ${count("pending")} pending.`;
    }),
};

/** `terminal_command`: runs a shell command in a terminal of the editor's, in the working folder. */
export const runCommand: Tool<typeof RunCommand.fields, Editor | CurrentCall> = {
  name: ToolName.make("terminal_command"),
  kind: "execute",
  replay: "unsafe",
  description: `Run a shell command in the editor's terminal, in the working folder. The result is its output and its exit code; an output over ${maxReadText} is cut to its last ${maxReadText}. Use it to list and search files (ls, find, grep) and run tests.`,
  input: RunCommand,
  run: (input) =>
    Effect.gen(function* () {
      const { connection, sessionId, cwd, terminals } = yield* Editor;
      const call = yield* CurrentCall;
      const seconds = input.timeout_seconds ?? commandSeconds;
      const { output, truncated, exited } = yield* Effect.acquireUseRelease(
        connection.client["terminal/create"]({ sessionId, command: "/bin/sh", args: ["-c", input.command], cwd, outputByteLimit: maxReadBytes }),
        ({ terminalId }) =>
          Ref.update(terminals, HashMap.set(call, terminalId)).pipe(
            Effect.andThen(
              connection
                .notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: ToolCallId.make(call), content: [{ type: "terminal", terminalId }] } })
                .pipe(Effect.ignore),
            ),
            Effect.andThen(connection.client["terminal/wait_for_exit"]({ sessionId, terminalId })),
            Effect.timeoutOption(Duration.seconds(seconds)),
            Effect.flatMap((ended) => connection.client["terminal/output"]({ sessionId, terminalId }).pipe(Effect.map(({ output, truncated }) => ({ output, truncated, exited: ended })))),
          ),
        ({ terminalId }) => connection.client["terminal/release"]({ sessionId, terminalId }).pipe(Effect.ignore),
      ).pipe(Effect.mapError((error) => failed("terminal_command", input.command)(error as never)));
      const ending = Option.match(exited, {
        onNone: () => `[Still running after ${seconds} seconds: stopped.]`,
        onSome: ({ exitCode, signal }) => (typeof exitCode === "number" ? `[Exit code ${exitCode}.]` : `[Stopped by signal ${signal ?? "unknown"}.]`),
      });
      const text = `${truncated ? `[The output's beginning was cut: its last ${maxReadText} follow.]\n` : ""}${output}${output.endsWith("\n") || output === "" ? "" : "\n"}${ending}`;
      // A command that exited 0 succeeded. One that exited otherwise, was stopped by a signal, or ran past its time failed, with its output.
      return Option.isSome(exited) && exited.value.exitCode === 0 ? text : yield* new Reported({ message: text });
    }),
};
