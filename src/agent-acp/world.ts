/**
 * What the ACP host does not know of a session: the world it works in. From `session/new`'s working
 * folder, the MCP servers the client named and the connection (the client's capabilities, its
 * `fs/*` methods), a world gives the session's system prompt, its tools (`ToolSpec`), the
 * `ToolRunner` that runs them and how their calls are shown (`Present`). The core is told what
 * happened; it never sees the world.
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
 * A path given to a tool is relative to the working folder, or absolute; one outside it is refused
 * with a failure the model reads.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { Duration, Effect, FileSystem, Layer, Option, Schema } from "effect";
import type { AgentConnection } from "../acp/agent.ts";
import type { V1Version } from "../acp/protocol.ts";
import { type McpServer, type SessionId, type TerminalId, ToolCallId } from "../acp/schema/v1.gen.ts";
import { type CallId, FailureText, ToolName } from "../agent-machine/names.ts";
import type { ToolOutcome } from "../agent-machine/observation.ts";
import { ToolRunner, type ToolSpec } from "../agent-session/contracts.ts";
import { parseJson, receivedText } from "../agent-session/received.ts";
import { workspaceTools } from "../agent-tools/workspace.ts";
import { type Present, presentFrom } from "./projection.ts";

/** What a world is given for one session, at `session/new`. */
export interface WorldOpening {
  readonly sessionId: SessionId;
  /** The working folder, absolute. */
  readonly cwd: string;
  readonly mcpServers: ReadonlyArray<McpServer>;
  readonly connection: AgentConnection<V1Version>;
}

/** One session's world: fixed when the session is made, and the same for every turn of it. */
export interface WorldSession {
  readonly system: string | undefined;
  readonly tools: ReadonlyArray<ToolSpec>;
  readonly runner: Layer.Layer<ToolRunner>;
  readonly present: Present;
}

export interface World<R = never> {
  readonly open: (opening: WorldOpening) => Effect.Effect<WorldSession, never, R>;
}

/** The most bytes a tool reads or writes in one call. */
export const maxFileBytes = 256 * 1024;

const ReadFile = Schema.Struct({
  path: Schema.NonEmptyString,
  line: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
const WriteFile = Schema.Struct({ path: Schema.NonEmptyString, content: Schema.String });
const EditFile = Schema.Struct({ path: Schema.NonEmptyString, old_text: Schema.NonEmptyString, new_text: Schema.String });
const RunCommand = Schema.Struct({
  command: Schema.NonEmptyString,
  timeout_seconds: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(600))),
});

const PlanEntryInput = Schema.Struct({
  content: Schema.NonEmptyString,
  status: Schema.Literals(["pending", "in_progress", "completed"]),
  priority: Schema.optionalKey(Schema.Literals(["high", "medium", "low"])),
});
const UpdatePlan = Schema.Struct({ entries: Schema.Array(PlanEntryInput) });

/** How long a command runs before it is stopped, unless the call says otherwise. */
export const commandSeconds = 120;

const rejected = (problem: string): ToolOutcome => ({ _tag: "Failed", reason: { _tag: "InputRejected", problem: FailureText.make(problem) } });
const reported = (message: string): ToolOutcome => ({ _tag: "Failed", reason: { _tag: "Reported", error: receivedText(message) } });
const succeeded = (output: string): ToolOutcome => ({ _tag: "Succeeded", output: receivedText(output) });

/** `path` resolved against `root`, or why it is refused: it leaves `root`. */
const inside = (root: string, path: string): { readonly full: string } | { readonly problem: string } => {
  const full = resolve(root, path);
  const from = relative(root, full);
  return from.startsWith("..") || isAbsolute(from) ? { problem: `${path} is not inside the working folder, ${root}.` } : { full };
};

/** `text` cut to at most `max` bytes of UTF-8, never inside a character, and the bytes left out. */
const cut = (text: string, max: number): { readonly kept: string; readonly omitted: number } => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { kept: text, omitted: 0 };
  let end = max;
  // A continuation byte (10xxxxxx) is inside a character: step back to the character's first byte.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return { kept: bytes.subarray(0, end).toString("utf8"), omitted: bytes.length - end };
};

/**
 * A command's outcome, for the model to read: its output, then how it ended. One that exited 0
 * succeeded; one that exited otherwise, was stopped by a signal, or ran past its time failed with
 * its output.
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
  const text = `${truncated ? "[The output's beginning was cut: its last 256 KiB follow.]\n" : ""}${output}${output.endsWith("\n") || output === "" ? "" : "\n"}${ending}`;
  return Option.isSome(exited) && exited.value.exitCode === 0 ? succeeded(text) : reported(text);
};

/** What a failed call to the editor is, for the model to read. */
const editorFailure = (method: string, path: string, error: { readonly _tag?: string; readonly message?: string; readonly reason?: string }): string =>
  `${method} ${path}: ${error._tag === "PeerClosed" ? `the editor's connection closed (${error.reason ?? ""})` : (error.message ?? error._tag ?? "the editor gave no reason")}`;

/**
 * The tools that go through the editor, for the methods the client advertised: `read_file` with
 * `fs/read_text_file`, `write_file` with `fs/write_text_file`.
 */
export const editorWorld: World = {
  open: ({ sessionId, cwd, connection }) =>
    Effect.sync(() => {
      const fs = connection.profile.client.capabilities.fs;
      const scope = ` Relative paths are inside the working folder, ${cwd}.`;
      const tools: Array<ToolSpec> = [];
      if (fs?.readTextFile === true)
        tools.push({
          name: ToolName.make("read_file"),
          kind: "read",
          replay: "safe",
          description: `Read a UTF-8 file as the editor has it, unsaved changes included, at most 256 KiB per result. Use line (1-based) and limit (a count of lines) to read a large file in parts, for example {"path": "src/a.ts", "line": 1, "limit": 100}.${scope}`,
          input: {
            type: "object",
            properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } },
            required: ["path"],
          },
        });
      if (fs?.writeTextFile === true)
        tools.push({
          name: ToolName.make("write_file"),
          kind: "edit",
          replay: "idempotent",
          description: `Create a UTF-8 file, or replace one, with the content given, at most 256 KiB, through the editor.${scope}`,
          input: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
        });
      if (fs?.readTextFile === true && fs.writeTextFile === true)
        tools.push({
          name: ToolName.make("edit_file"),
          kind: "edit",
          replay: "unsafe",
          description: `Replace one occurrence of old_text in a UTF-8 file with new_text, through the editor, its unsaved changes included. old_text must occur exactly once: include enough of the lines around it to make it so.${scope}`,
          input: {
            type: "object",
            properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
            required: ["path", "old_text", "new_text"],
          },
        });
      tools.push({
        name: ToolName.make("update_plan"),
        kind: "think",
        replay: "safe",
        description:
          "Record your plan for the task as a list of steps, each pending, in_progress or completed, with an optional priority (high, medium, low); the user sees it in the editor. Send the whole list each time it changes; keep one step in_progress while you work on it.",
        input: {
          type: "object",
          properties: {
            entries: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  content: { type: "string" },
                  status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                  priority: { type: "string", enum: ["high", "medium", "low"] },
                },
                required: ["content", "status"],
              },
            },
          },
          required: ["entries"],
        },
      });
      if (connection.profile.client.capabilities.terminal === true)
        tools.push({
          name: ToolName.make("run_command"),
          kind: "execute",
          replay: "unsafe",
          description: `Run a shell command (sh -c) in the editor's terminal, in the working folder, and get its output (the last 256 KiB) and how it exited. It is stopped after timeout_seconds (${commandSeconds} unless given; at most 600). Use it to list and search files (ls, find, grep), run tests and use git.${scope}`,
          input: {
            type: "object",
            properties: { command: { type: "string" }, timeout_seconds: { type: "integer", minimum: 1, maximum: 600 } },
            required: ["command"],
          },
        });

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
              omitted === 0 ? kept : `${kept}\n[Cut at 256 KiB: ${omitted} bytes left out. Read the rest with line and limit.]`,
            );
          }),
          Effect.catch((error) => Effect.succeed(reported(editorFailure("fs/read_text_file", input.path, error)))),
        );
      };

      const write = (input: typeof WriteFile.Type) => {
        const at = inside(cwd, input.path);
        if ("problem" in at) return Effect.succeed(rejected(at.problem));
        const bytes = Buffer.byteLength(input.content);
        if (bytes > maxFileBytes) return Effect.succeed(rejected(`The content is over 256 KiB (${bytes} bytes). Write less.`));
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
            if (bytes > maxFileBytes) return Effect.succeed(rejected(`The file would be over 256 KiB (${bytes} bytes).`));
            return connection.client["fs/write_text_file"]({ sessionId, path: at.full, content: changed }).pipe(Effect.as(succeeded(`Edited ${input.path}.`)));
          }),
          Effect.catch((error) => Effect.succeed(reported(editorFailure("edit_file", input.path, error as never)))),
        );
      };

      // The terminal each command ran in, by call: shown in the call as it runs, and when it has ended.
      const terminals = new Map<CallId, TerminalId>();

      // The terminal is released however the call ends, which stops a command still running.
      const runCommand = (call: CallId) => (input: typeof RunCommand.Type) => {
        const seconds = input.timeout_seconds ?? commandSeconds;
        return Effect.acquireUseRelease(
          connection.client["terminal/create"]({ sessionId, command: "/bin/sh", args: ["-c", input.command], cwd, outputByteLimit: maxFileBytes }),
          ({ terminalId }) =>
            Effect.sync(() => terminals.set(call, terminalId)).pipe(
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

      const decoded = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, tool: string, input: unknown, run: (value: S["Type"]) => Effect.Effect<ToolOutcome>) =>
        Schema.decodeUnknownEffect(schema)(input).pipe(
          Effect.matchEffect({ onFailure: (error) => Effect.succeed(rejected(`${tool} does not take this input: ${error.message}`)), onSuccess: run }),
        );

      const runner = Layer.succeed(ToolRunner, {
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
      });

      const plain = presentFrom(tools);
      // A file's path as its location; an edit's change as a diff, before it runs (when permission
      // is asked) and once it succeeded; a command's terminal, once it has one.
      const present: Present = (call, outcome) => {
        const shown = plain(call, outcome);
        const parsed = parseJson(call.input);
        const input = "value" in parsed && typeof parsed.value === "object" && parsed.value !== null ? (parsed.value as Record<string, unknown>) : {};
        const terminalId = terminals.get(call.call);
        if (call.tool === "run_command" && terminalId !== undefined) return { ...shown, content: [{ type: "terminal", terminalId }] };
        const at = typeof input["path"] === "string" ? inside(cwd, input["path"]) : undefined;
        if (at === undefined || "problem" in at) return shown;
        const located = { ...shown, locations: [{ path: at.full }] };
        const edited = call.tool === "edit_file" && typeof input["old_text"] === "string" && typeof input["new_text"] === "string";
        return edited && (outcome === undefined || outcome._tag === "Succeeded")
          ? { ...located, content: [{ type: "diff", path: at.full, oldText: input["old_text"] as string, newText: input["new_text"] as string }] }
          : located;
      };

      return { system: `The working folder is ${cwd}.`, tools, runner, present };
    }),
};

/**
 * A stopgap world: the workspace tools of `agent-tools/workspace.ts` on the local disk under the
 * working folder. It bypasses the editor, so the model does not see unsaved buffers and the editor
 * is not told of writes.
 */
export const workspaceWorld: World<FileSystem.FileSystem> = {
  open: ({ cwd }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = workspaceTools(cwd);
      return {
        system: `The working folder is ${cwd}.`,
        tools: workspace.catalog,
        runner: workspace.runner.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, fs))),
        present: presentFrom(workspace.catalog),
      };
    }),
};
