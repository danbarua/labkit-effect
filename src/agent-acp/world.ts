/**
 * What the ACP host does not know of a session: the world it works in. From `session/new`'s working
 * folder, the MCP servers the client named and the connection (the client's capabilities, its
 * `fs/*` methods), a world returns the session's system prompt, its tool sources (`ToolSource`: the
 * tools and what runs a call to one) and how their calls are shown (`Present`). The core records
 * what happened, and never sees the world.
 *
 * - `editorWorld`, the default: the tools go through the editor. `read_file` reads with the client's
 *   `fs/read_text_file`, so the model sees the editor's unsaved buffers; `write_file` writes with
 *   `fs/write_text_file`; `edit_file` replaces one occurrence of a text with both; `run_command`
 *   runs a shell command in the editor's terminal (`terminal/create`), which is how a folder is
 *   listed or searched, since the editor has no method for either. Each is offered only when the
 *   client advertised the methods it uses (`clientCapabilities.fs.readTextFile`, `.writeTextFile`,
 *   `.terminal`), so no call meets a capability the client does not have. `update_plan` sends the
 *   model's plan to the editor (a `plan` update), which shows it; every client gets it.
 * - `workspaceWorld`: a stopgap. The tools of `agent-tools/workspace.ts` (`read_file`, `list_dir`,
 *   `write_file`) on the local disk under the working folder, bypassing the editor and its unsaved
 *   buffers. A launcher chooses it explicitly.
 *
 * A path given to a tool is relative to the working folder, or absolute. A path outside the working
 * folder is refused with a failure the model reads.
 */

import type { Environment } from "../agent-process/environment.ts";
import { Duration, Effect, FileSystem, HashMap, Option, Ref, Schema } from "effect";
import type { AgentConnection } from "effective-acp/agent";
import type { V1Version } from "effective-acp/protocol";
import { type McpServer, type SessionId, type TerminalId, ToolCallId } from "effective-acp/schema/v1";
import { type CallId, FailureText, ToolName } from "../agent-machine/names.ts";
import type { ToolOutcome } from "../agent-machine/observation.ts";
import type { ToolSpec } from "../agent-session/contracts.ts";
import type { ToolSource } from "../agent-session/tool-sources.ts";
import { decoderOf, ignoredNote, jsonSchemaOf } from "../agent-session/tool-input.ts";
import { logKeys } from "../agent-session/log-keys.ts";
import { asText, parseJson, receivedText } from "../agent-session/received.ts";
import { inside, workspaceInput } from "../agent-tools/in-workspace.ts";
import { FilePath } from "../agent-tools/paths.ts";
import { commandSeconds, EditFile, maxReadBytes, maxReadText, ReadFile, RunCommand, workingFolderLine, workspaceTools } from "../agent-tools/workspace.ts";
import { type Present, type Presented, presentFrom } from "./projection.ts";

/** What a world is given for one session, when the session is made. */
export interface WorldOpening {
  readonly sessionId: SessionId;
  /** The working folder, absolute. */
  readonly cwd: string;
  readonly mcpServers: ReadonlyArray<McpServer>;
  readonly connection: AgentConnection<V1Version>;
  /**
   * Whether a tool call whose input has properties its tool does not take is refused. If not, the
   * call runs without them, and its result names the properties that were ignored.
   */
  readonly strictInput: boolean;
  /**
   * The environment that a command the model runs on the local disk receives (the configuration's
   * `commandEnvironment`); when left out, this process's environment without its credentials. A
   * command run in the editor's terminal receives the editor's environment.
   */
  readonly environment?: Environment | undefined;
}

/** One session's world: fixed when the session is made, and the same for every turn of it. */
export interface WorldSession {
  readonly system: string | undefined;
  /** In order. The session's tools are the tools of all of them, joined (`toolsOf`). */
  readonly sources: ReadonlyArray<ToolSource>;
  readonly present: Present;
}

export interface World<R = never> {
  readonly open: (opening: WorldOpening) => Effect.Effect<WorldSession, never, R>;
}

/** The maximum number of bytes that a tool reads or writes in one call. */
export const maxFileBytes = maxReadBytes;

const WriteFile = Schema.Struct({ path: FilePath, content: Schema.String.annotate({ description: `The file's new text, at most ${maxReadText}.` }) });

const PlanEntryInput = Schema.Struct({
  content: Schema.NonEmptyString.annotate({ description: "What the step does." }),
  status: Schema.Literals(["pending", "in_progress", "completed"]).annotate({ description: "The step's status. Keep one step in_progress while you work on it." }),
  priority: Schema.optionalKey(Schema.Literals(["high", "medium", "low"]).annotate({ description: "Optional: the step's priority. Default: medium." })),
});
const UpdatePlan = Schema.Struct({
  entries: Schema.Array(PlanEntryInput).annotate({ description: "Every step of the plan, in order. Send the whole list each time it changes." }),
});

const rejected = (problem: string): ToolOutcome => ({ _tag: "Failed", reason: { _tag: "InputRejected", problem: FailureText.make(problem) } });
const reported = (message: string): ToolOutcome => ({ _tag: "Failed", reason: { _tag: "Reported", error: receivedText(message) } });
const succeeded = (output: string): ToolOutcome => ({ _tag: "Succeeded", output: receivedText(output) });

/** Returns `text` cut to at most `max` bytes of UTF-8, never inside a character, and how many bytes were cut. */
const cut = (text: string, max: number): { readonly kept: string; readonly omitted: number } => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { kept: text, omitted: 0 };
  const end = characterStart(bytes, max);
  return { kept: bytes.subarray(0, end).toString("utf8"), omitted: bytes.length - end };
};

/** Returns `at`, or, when the byte there is inside a character (a continuation byte, 10xxxxxx), the position of the character's first byte. */
const characterStart = (bytes: Uint8Array, at: number): number => (at > 0 && ((bytes[at] ?? 0) & 0xc0) === 0x80 ? characterStart(bytes, at - 1) : at);

/** Returns `tool` in a list when `offered` is true, else an empty list. */
const offeredIf = (offered: boolean, tool: ToolSpec): ReadonlyArray<ToolSpec> => (offered ? [tool] : []);

/**
 * Returns a command's outcome, for the model to read: its output, then how it ended. A command that
 * exited 0 succeeded. A command that exited otherwise, was stopped by a signal, or ran past its
 * time failed, with its output.
 */
const commandOutcome = (
  output: string,
  truncated: boolean,
  exited: Option.Option<{ readonly exitCode?: number | null; readonly signal?: string | null }>,
  seconds: number,
): ToolOutcome => {
  const ending = Option.match(exited, {
    onNone: () => `[Still running after ${seconds} seconds: stopped.]`,
    onSome: ({ exitCode, signal }) => (typeof exitCode === "number" ? `[Exit code ${exitCode}.]` : `[Stopped by signal ${signal ?? "unknown"}.]`),
  });
  const text = `${truncated ? `[The output's beginning was cut: its last ${maxReadText} follow.]\n` : ""}${output}${output.endsWith("\n") || output === "" ? "" : "\n"}${ending}`;
  return Option.isSome(exited) && exited.value.exitCode === 0 ? succeeded(text) : reported(text);
};

/** Returns `text` on one line of at most 120 characters, for a title. */
const oneLine = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
};

/** Returns `outcome` with `note` after its output, or after the error it reported. */
const noted = (outcome: ToolOutcome, note: string): ToolOutcome => {
  if (outcome._tag === "Succeeded") return succeeded(`${asText(outcome.output)}${note}`);
  return outcome.reason._tag === "Reported" ? reported(`${asText(outcome.reason.error)}${note}`) : outcome;
};

/** Returns what a call is about, for its title: its command, else its path. */
const aboutOf = (input: Readonly<Record<string, unknown>>): string | undefined => {
  if (typeof input["command"] === "string") return input["command"];
  return typeof input["path"] === "string" ? input["path"] : undefined;
};

/** Returns a description of a failed call to the editor, for the model to read. */
const editorFailure = (method: string, path: string, error: { readonly _tag?: string; readonly message?: string; readonly reason?: string }): string =>
  `${method} ${path}: ${error._tag === "PeerClosed" ? `the editor's connection closed (${error.reason ?? ""})` : (error.message ?? error._tag ?? "the editor gave no reason")}`;

/**
 * The tools that go through the editor, for the methods the client advertised: `read_file` with
 * `fs/read_text_file`, `write_file` with `fs/write_text_file`, `edit_file` with both, `run_command`
 * with `terminal/*`; and `update_plan` for every client.
 */
export const editorWorld: World = {
  open: ({ sessionId, cwd, connection, strictInput }) =>
    Effect.gen(function* () {
      const fs = connection.profile.client.capabilities.fs;
      const tools: ReadonlyArray<ToolSpec> = [
        ...offeredIf(fs?.readTextFile === true, {
          name: ToolName.make("read_file"),
          kind: "read",
          replay: "safe",
          description: `Read a UTF-8 text file in the working folder as the editor has it, unsaved changes included. A result is at most ${maxReadText}: read a larger file in parts with line and limit.`,
          input: jsonSchemaOf(workspaceInput(ReadFile)),
        }),
        ...offeredIf(fs?.writeTextFile === true, {
          name: ToolName.make("write_file"),
          kind: "edit",
          replay: "idempotent",
          description: "Create a UTF-8 text file in the working folder, or replace one, through the editor.",
          input: jsonSchemaOf(workspaceInput(WriteFile)),
        }),
        ...offeredIf(fs?.readTextFile === true && fs.writeTextFile === true, {
          name: ToolName.make("edit_file"),
          kind: "edit",
          replay: "unsafe",
          description: "Replace one occurrence of old_text with new_text in a UTF-8 text file in the working folder, through the editor, its unsaved changes included.",
          input: jsonSchemaOf(workspaceInput(EditFile)),
        }),
        {
          name: ToolName.make("update_plan"),
          kind: "think",
          replay: "safe",
          description: "Record your plan for the task as a list of steps. The user sees the plan in the editor.",
          input: jsonSchemaOf(UpdatePlan),
        },
        ...offeredIf(connection.profile.client.capabilities.terminal === true, {
          name: ToolName.make("run_command"),
          kind: "execute",
          replay: "unsafe",
          description: `Run a shell command in the editor's terminal, in the working folder. The result is its output and its exit code; an output over ${maxReadText} is cut to its last ${maxReadText}. Use it to list and search files (ls, find, grep), run tests and use git.`,
          input: jsonSchemaOf(RunCommand),
        }),
      ];

      const read = (input: typeof ReadFile.Type) => {
        const at = inside(cwd, input.path);
        if ("problem" in at) return Effect.succeed(rejected(at.problem));
        return connection.client["fs/read_text_file"]({
          sessionId,
          path: at.full,
          ...(input.line === undefined ? {} : { line: input.line }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }).pipe(
          Effect.map(({ content }) => {
            const { kept, omitted } = cut(content, maxFileBytes);
            return succeeded(
              omitted === 0 ? kept : `${kept}\n[Cut at ${maxReadText}: ${omitted} bytes left out. Read the rest with line and limit.]`,
            );
          }),
          Effect.catch((error) => Effect.succeed(reported(editorFailure("fs/read_text_file", input.path, error)))),
        );
      };

      const write = (input: typeof WriteFile.Type) => {
        const at = inside(cwd, input.path);
        if ("problem" in at) return Effect.succeed(rejected(at.problem));
        const bytes = Buffer.byteLength(input.content);
        if (bytes > maxFileBytes) return Effect.succeed(rejected(`The content is over ${maxReadText} (${bytes} bytes). Write less.`));
        return connection.client["fs/write_text_file"]({ sessionId, path: at.full, content: input.content }).pipe(
          Effect.as(succeeded(`Wrote ${bytes} bytes to ${input.path}.`)),
          Effect.catch((error) => Effect.succeed(reported(editorFailure("fs/write_text_file", input.path, error)))),
        );
      };

      const editText = (input: typeof EditFile.Type) => {
        const at = inside(cwd, input.path);
        if ("problem" in at) return Effect.succeed(rejected(at.problem));
        return connection.client["fs/read_text_file"]({ sessionId, path: at.full }).pipe(
          Effect.flatMap(({ content }): Effect.Effect<ToolOutcome, unknown> => {
            const count = content.split(input.old_text).length - 1;
            if (count !== 1)
              return Effect.succeed(
                rejected(count === 0 ? `old_text does not occur in ${input.path}.` : `old_text occurs ${count} times in ${input.path}; include more of the lines around it so that it occurs once.`),
              );
            const changed = content.replace(input.old_text, () => input.new_text);
            const bytes = Buffer.byteLength(changed);
            if (bytes > maxFileBytes) return Effect.succeed(rejected(`The file would be over ${maxReadText} (${bytes} bytes).`));
            return connection.client["fs/write_text_file"]({ sessionId, path: at.full, content: changed }).pipe(Effect.as(succeeded(`Edited ${input.path}.`)));
          }),
          Effect.catch((error) => Effect.succeed(reported(editorFailure("edit_file", input.path, error as never)))),
        );
      };

      // The terminal each command ran in, by call: shown in the call as it runs, and when it has ended.
      const terminals = yield* Ref.make(HashMap.empty<CallId, TerminalId>());

      // The terminal is released however the call ends, which stops a command still running.
      const runCommand = (call: CallId) => (input: typeof RunCommand.Type) => {
        const seconds = input.timeout_seconds ?? commandSeconds;
        return Effect.acquireUseRelease(
          connection.client["terminal/create"]({ sessionId, command: "/bin/sh", args: ["-c", input.command], cwd, outputByteLimit: maxFileBytes }),
          ({ terminalId }) =>
            Ref.update(terminals, HashMap.set(call, terminalId)).pipe(
              Effect.andThen(
                connection
                  .notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: ToolCallId.make(call), content: [{ type: "terminal", terminalId }] } })
                  .pipe(Effect.ignore),
              ),
              Effect.andThen(connection.client["terminal/wait_for_exit"]({ sessionId, terminalId })),
              Effect.timeoutOption(Duration.seconds(seconds)),
              Effect.flatMap((exited) =>
                connection.client["terminal/output"]({ sessionId, terminalId }).pipe(Effect.map(({ output, truncated }) => commandOutcome(output, truncated, exited, seconds))),
              ),
            ),
          ({ terminalId }) => connection.client["terminal/release"]({ sessionId, terminalId }).pipe(Effect.ignore),
        ).pipe(Effect.catch((error) => Effect.succeed(reported(editorFailure("run_command", input.command, error as never)))));
      };

      const updatePlan = (input: typeof UpdatePlan.Type) => {
        const entries = input.entries.map((entry) => ({ content: entry.content, status: entry.status, priority: entry.priority ?? "medium" }));
        const count = (status: string) => entries.filter((entry) => entry.status === status).length;
        return connection.notify("session/update", { sessionId, update: { sessionUpdate: "plan", entries } }).pipe(
          Effect.as(succeeded(`The plan has ${entries.length} steps: ${count("completed")} completed, ${count("in_progress")} in progress, ${count("pending")} pending.`)),
          Effect.catch((error) => Effect.succeed(reported(editorFailure("update_plan", "the plan", error as never)))),
        );
      };

      const decoded = <S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }>(
        schema: S,
        tool: string,
        input: unknown,
        run: (value: S["Type"]) => Effect.Effect<ToolOutcome>,
      ) =>
        decoderOf(schema, strictInput)(input).pipe(
          Effect.matchEffect({
            onFailure: (error) => Effect.succeed(rejected(`${tool} does not take this input: ${error.message}`)),
            onSuccess: ({ value, ignored }) =>
              ignored.length === 0
                ? run(value)
                : Effect.logWarning(logKeys.tools.inputIgnored, { tool, ignored }).pipe(
                    Effect.andThen(run(value)),
                    Effect.map((outcome) => noted(outcome, ignoredNote(tool, ignored))),
                  ),
          }),
        );

      const source: ToolSource = {
        tools,
        run: (name, input, call) => {
          if (!tools.some((tool) => tool.name === name)) return Effect.succeed<ToolOutcome>({ _tag: "Failed", reason: { _tag: "NotFound" } });
          const parsed = parseJson(input);
          if ("reason" in parsed) return Effect.succeed(rejected(`The input could not be read: ${parsed.reason}.`));
          switch (name) {
            case "read_file":
              return decoded(ReadFile, name, parsed.value, read);
            case "write_file":
              return decoded(WriteFile, name, parsed.value, write);
            case "edit_file":
              return decoded(EditFile, name, parsed.value, editText);
            case "update_plan":
              return decoded(UpdatePlan, name, parsed.value, updatePlan);
            default:
              return decoded(RunCommand, name, parsed.value, runCommand(call));
          }
        },
      };

      const plain = presentFrom(tools);
      // The title names what the call is about, its command or its path, so a permission question
      // shows what it asks about. A file's path is its location. An edit's change is shown as a diff
      // before it runs (when permission is asked) and once it succeeded. A command's terminal is shown
      // once the call has one.
      const present: Present = (call, outcome) =>
        Effect.gen(function* () {
          const parsed = parseJson(call.input);
          const input = "value" in parsed && typeof parsed.value === "object" && parsed.value !== null ? (parsed.value as Record<string, unknown>) : {};
          const about = aboutOf(input);
          const shown: Presented = { ...(yield* plain(call, outcome)), ...(about === undefined ? {} : { title: `${call.tool}: ${oneLine(about)}` }) };
          const terminalId = Option.getOrUndefined(HashMap.get(yield* Ref.get(terminals), call.call));
          if (call.tool === "run_command" && terminalId !== undefined) return { ...shown, content: [{ type: "terminal", terminalId }] } satisfies Presented;
          const at = typeof input["path"] === "string" ? inside(cwd, input["path"]) : undefined;
          if (at === undefined || "problem" in at) return shown;
          const located: Presented = { ...shown, locations: [{ path: at.full }] };
          const edited = call.tool === "edit_file" && typeof input["old_text"] === "string" && typeof input["new_text"] === "string";
          return edited && (outcome === undefined || outcome._tag === "Succeeded")
            ? ({ ...located, content: [{ type: "diff", path: at.full, oldText: input["old_text"] as string, newText: input["new_text"] as string }] } satisfies Presented)
            : located;
        });

      return { system: workingFolderLine(cwd), sources: [source], present };
    }),
};

/**
 * A stopgap world: the workspace tools of `agent-tools/workspace.ts` on the local disk under the
 * working folder. It bypasses the editor, so the model does not see unsaved buffers, and the editor
 * is not notified of writes.
 */
export const workspaceWorld: World<FileSystem.FileSystem> = {
  open: ({ cwd, strictInput, environment }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = workspaceTools(cwd, { strictInput, ...(environment === undefined ? {} : { environment }) });
      return {
        system: workspace.system,
        sources: [yield* workspace.source.pipe(Effect.provideService(FileSystem.FileSystem, fs))],
        present: presentFrom(workspace.catalog),
      };
    }),
};
