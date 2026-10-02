/**
 * What the ACP host does not know of a session: the world it works in. From `session/new`'s working
 * folder, the MCP servers the client named and the connection (the client's capabilities, its
 * `fs/*` methods), a world gives the session's system prompt, its tools (`ToolSpec`), the
 * `ToolRunner` that runs them and how their calls are shown (`Present`). The core is told what
 * happened; it never sees the world.
 *
 * - `editorWorld`, the default: the tools go through the editor. `read_file` reads with the client's
 *   `fs/read_text_file`, so the model sees the editor's unsaved buffers; `write_file` writes with
 *   `fs/write_text_file`. Each is offered only when the client advertised its method
 *   (`clientCapabilities.fs.readTextFile`, `.writeTextFile`), so no call meets a capability the
 *   client does not have; a client that advertised neither gets no tools. The editor has no method
 *   to list a folder, so there is no `list_dir`.
 * - `workspaceWorld`: a stopgap. The tools of `agent-tools/workspace.ts` (`read_file`, `list_dir`,
 *   `write_file`) on the local disk under the working folder, bypassing the editor and its unsaved
 *   buffers. A launcher chooses it explicitly.
 *
 * A path given to a tool is relative to the working folder, or absolute; one outside it is refused
 * with a failure the model reads.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { Effect, FileSystem, Layer, Schema } from "effect";
import type { AgentConnection } from "../acp/agent.ts";
import type { V1Version } from "../acp/protocol.ts";
import type { McpServer, SessionId } from "../acp/schema/v1.gen.ts";
import { FailureText, ToolName } from "../agent-machine/names.ts";
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

      const decoded = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, tool: string, input: unknown, run: (value: S["Type"]) => Effect.Effect<ToolOutcome>) =>
        Schema.decodeUnknownEffect(schema)(input).pipe(
          Effect.matchEffect({ onFailure: (error) => Effect.succeed(rejected(`${tool} does not take this input: ${error.message}`)), onSuccess: run }),
        );

      const runner = Layer.succeed(ToolRunner, {
        run: (name, input) => {
          if (!tools.some((tool) => tool.name === name)) return Effect.succeed<ToolOutcome>({ _tag: "Failed", reason: { _tag: "NotFound" } });
          const parsed = parseJson(input);
          if ("reason" in parsed) return Effect.succeed(rejected(`The input could not be read: ${parsed.reason}.`));
          return name === "read_file" ? decoded(ReadFile, name, parsed.value, read) : decoded(WriteFile, name, parsed.value, write);
        },
      });

      const plain = presentFrom(tools);
      const present: Present = (call, outcome) => {
        const shown = plain(call, outcome);
        const input = parseJson(call.input);
        const path = "value" in input && typeof input.value === "object" && input.value !== null && "path" in input.value ? input.value["path"] : undefined;
        const at = typeof path === "string" ? inside(cwd, path) : undefined;
        return at === undefined || "problem" in at ? shown : { ...shown, locations: [{ path: at.full }] };
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
