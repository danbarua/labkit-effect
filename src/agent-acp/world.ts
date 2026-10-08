/**
 * What the ACP host does not know of a session: the world it works in. From `session/new`'s working
 * folder, the MCP servers the client named and the connection (the client's capabilities, its
 * `fs/*` methods), a world returns the session's system prompt, its tool sources (`ToolSource`: the
 * tools and what runs a call to one) and how their calls are shown (`Present`). The core records
 * what happened, and never sees the world.
 *
 * - `editorWorld`, the default: the tools go through the editor. `read_file` reads with the client's
 *   `fs/read_text_file`, so the model sees the editor's unsaved buffers; `write_file` writes with
 *   `fs/write_text_file`; `edit_file` replaces one occurrence of a text with both; `terminal_command`
 *   runs a shell command in the editor's terminal (`terminal/create`), which is how a folder is
 *   listed or searched, since the editor has no method for either. Each is offered only when the
 *   client advertised the methods it uses (`clientCapabilities.fs.readTextFile`, `.writeTextFile`,
 *   `.terminal`), so no call meets a capability the client does not have. `update_plan` sends the
 *   model's plan to the editor (a `plan` update), which shows it; every client gets it.
 * - `workspaceWorld`: a stopgap. The tools of `agent-tools/workspace.ts` (`read_file`, `list_dir`,
 *   `write_file`) on the local disk under the working folder, bypassing the editor and its unsaved
 *   buffers. A launcher chooses it explicitly.
 *
 * In both worlds, when the working folder is the root of a git repository (it holds `.git`), the
 * session is also offered the git tools of `agent-tools/git.ts`, bound to that repository, and the
 * system text says so. The git tools work on the disk, not through the editor: `git_add` stages
 * what is saved, not an unsaved buffer, and `git_restore`, `git_reset` and `git_checkout` change
 * files without the editor being told. A working folder inside a repository, below its root, is
 * offered no git tools.
 *
 * A path given to a tool is relative to the working folder, from `~`, or absolute. The tools refuse
 * no path: the permission policy asks about a path outside the working folders.
 */

import type { Environment } from "../agent-process/environment.ts";
import { Effect, FileSystem, HashMap, Option, Ref } from "effect";
import { homedir } from "node:os";
import { type PlannedWrite, plannedWrites, type ShownWrite, shownWrites, writtenFiles } from "../agent-host/command-writes.ts";
import { logKeys } from "../agent-session/log-keys.ts";
import { type Current, currentOnDisk, recordingWrites } from "../agent-tools/file-change.ts";
import { ShellCommand, WordText } from "../agent-policy/command-segments.ts";
import type { Folders } from "../agent-policy/command-units.ts";
import type { AgentConnection } from "effective-acp/agent";
import type { V1Version } from "effective-acp/protocol";
import type { McpServer, SessionId, TerminalId, ToolCallContent } from "effective-acp/schema/v1";
import type { CallId } from "../agent-machine/names.ts";
import type { ToolSource } from "../agent-session/tool-sources.ts";
import { parseJson } from "../agent-session/received.ts";
import { described } from "../agent-tools/described.ts";
import { gitTools, isRepositoryRoot } from "../agent-tools/git.ts";
import { inWorkspace } from "../agent-tools/in-workspace.ts";
import { blobReads } from "../agent-tools/blob-reads.ts";
import { fullPathIn } from "../agent-tools/paths.ts";
import { type AnyTool, type CurrentCall, anyTool, sourceOf } from "../agent-tools/tool.ts";
import { maxReadBytes, workingFolderLine, workspaceTools } from "../agent-tools/workspace.ts";
import { Editor, editFile, readFile, runCommand, updatePlan, writeFile } from "./editor-tools.ts";
import { changedFiles, oneLine, type Present, type Presented, presentFrom } from "./projection.ts";

/** What a world is given for one session, when the session is made. */
export interface WorldOpening {
  readonly sessionId: SessionId;
  /** The working folder, absolute. */
  readonly cwd: string;
  /** The folders that count as inside the working folder (`additionalDirectories`, `--add-dir`), absolute. */
  readonly additionalFolders?: ReadonlyArray<string> | undefined;
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

/** Returns what a call is about, for its title: its command, else its path. */
const aboutOf = (input: Readonly<Record<string, unknown>>): string | undefined => {
  if (typeof input["command"] === "string") return input["command"];
  return typeof input["path"] === "string" ? input["path"] : undefined;
};

/** The git tools bound to the working folder `cwd`, when it is the root of a git repository; undefined otherwise. */
const gitToolsAt = (cwd: string, strictInput: boolean) => (isRepositoryRoot(cwd) ? gitTools(cwd, { strictInput }) : undefined);

/** Returns the system text for the working folder `cwd`: the line that names it, and the git tools' line when it is a repository's root. */
const systemFor = (cwd: string, git: ReturnType<typeof gitToolsAt>, additional: ReadonlyArray<string> = []): Effect.Effect<string> =>
  Effect.map(git === undefined ? Effect.succeed("") : Effect.map(git.system, (line) => ` ${line}`), (line) => `${workingFolderLine(cwd, additional)}${line}`);

/**
 * The tools that go through the editor (`editor-tools.ts`), for the methods the client advertised:
 * `read_file` with `fs/read_text_file`, `write_file` with `fs/write_text_file`, `edit_file` with
 * both, `terminal_command` with `terminal/*`; and `update_plan` for every client. Every tool takes an
 * `intent` (`described`), and the file tools' paths are resolved against the working folder
 * (`inWorkspace`). The world provides the editor (`Editor`) to the tools.
 */
/**
 * A command's write as a call's content: a diff of the file, with a note when the shell expands the
 * text it writes; or why no diff is shown (the permission question shows the text).
 */
const writeContent = (write: ShownWrite): ReadonlyArray<ToolCallContent> => {
  if (write._tag === "NoDiff") return [{ type: "content", content: { type: "text", text: `No diff of ${write.writes.path} is shown: ${write.reason}.` } }];
  const diff: ToolCallContent = { type: "diff", path: write.full, oldText: write.before ?? null, newText: write.after };
  return write.writes.expands ? [diff, { type: "content", content: { type: "text", text: `When the command runs, the shell replaces \`$…\` and backquoted commands in the text it writes to ${write.writes.path}, so the file may differ from this diff.` } }] : [diff];
};

/** A write a replayed call made, in words: `Wrote config.yml.`, or `Added to the end of notes.md.` for `>>`. */
const wroteContent = (planned: PlannedWrite): ToolCallContent => ({
  type: "content",
  content: { type: "text", text: `${planned.writes.append ? "Added to the end of" : "Wrote"} ${planned.writes.path}.` },
});

export const editorWorld: World<FileSystem.FileSystem> = {
  open: ({ sessionId, cwd, connection, strictInput, additionalFolders }) =>
    Effect.gen(function* () {
      const fs = connection.profile.client.capabilities.fs;
      const additional = additionalFolders ?? [];
      const disk = yield* FileSystem.FileSystem;
      // The terminal each command ran in, by call: shown in the call as it runs, and when it has ended.
      const terminals = yield* Ref.make(HashMap.empty<CallId, TerminalId>());
      // What each command writes to files, with their text before it ran: read once, before it runs.
      const writes = yield* Ref.make(HashMap.empty<CallId, ReadonlyArray<ShownWrite>>());
      const folders: Folders = { working: WordText.make(cwd), home: WordText.make(homedir()) };
      // A file's current text: whether it exists from the disk, and its text from the editor, so that an unsaved change counts.
      const currentOf = (full: string, path: string): Effect.Effect<Current> =>
        currentOnDisk(disk, full, path).pipe(
          Effect.filterOrElse(
            (current) => current._tag !== "Text" || fs?.readTextFile !== true,
            () =>
              connection.client["fs/read_text_file"]({ sessionId, path: full }).pipe(
                Effect.map(({ content }): Current => ({ _tag: "Text", text: content })),
                Effect.catch((error) =>
                  Effect.logWarning(logKeys.tools.currentUnread, { path, full, cause: error.message }).pipe(
                    Effect.as<Current>({ _tag: "Unknown", reason: `the editor could not read its current text: ${error.message}` }),
                  ),
                ),
              ),
          ),
        );
      const writesBefore = (call: CallId, command: ShellCommand): Effect.Effect<ReadonlyArray<ShownWrite>> =>
        Effect.gen(function* () {
          const known = HashMap.get(yield* Ref.get(writes), call);
          if (Option.isSome(known)) return known.value;
          const shown = yield* shownWrites(command, folders, currentOf);
          // The first reading kept wins: a later one may have read after the command ran.
          return yield* Ref.modify(writes, (all) =>
            Option.match(HashMap.get(all, call), { onSome: (kept) => [kept, all] as const, onNone: () => [shown, HashMap.set(all, call, shown)] as const }),
          );
        });
      // A call's writes: read while it runs live and has not ended, before its command runs; otherwise
      // those read before it ran, or none (a replayed call's files were read after it ran).
      const writesShown = (call: CallId, command: ShellCommand | undefined, readNow: boolean): Effect.Effect<ReadonlyArray<ShownWrite>> => {
        if (command === undefined) return Effect.succeed([]);
        if (readNow) return writesBefore(call, command);
        return Ref.get(writes).pipe(Effect.map((all) => Option.getOrElse(HashMap.get(all, call), () => [])));
      };
      const inFolder = inWorkspace(cwd);
      const tools: ReadonlyArray<AnyTool<Editor | CurrentCall | FileSystem.FileSystem>> = [
        ...(fs?.readTextFile === true ? [anyTool(described(blobReads(inFolder(readFile))))] : []),
        ...(fs?.writeTextFile === true ? [anyTool(described(inFolder(writeFile)))] : []),
        ...(fs?.readTextFile === true && fs.writeTextFile === true ? [anyTool(described(inFolder(editFile)))] : []),
        anyTool(described(updatePlan)),
        // A command records the files it writes from the disk, which it writes, read just before and after it runs; what is shown before it runs is read through the editor (`writesBefore`).
        ...(connection.profile.client.capabilities.terminal === true ? [anyTool(described(recordingWrites(writtenFiles(folders))(runCommand)))] : []),
      ];
      const source = yield* sourceOf(tools, { strictInput }).pipe(Effect.provideService(Editor, { connection, sessionId, cwd, terminals, writesBefore, currentOf }));

      const git = gitToolsAt(cwd, strictInput);
      const plain = presentFrom([...source.tools, ...(git?.catalog ?? [])]);
      // A call that gives its intent is titled with it (`presentFrom`). A call without one (recorded
      // before its tool took an intent) is titled with what it is about, its command or its path. A
      // permission question also carries the call's whole input (`permission.ts`). A file's path is
      // its location. An edit's change is shown as a diff
      // before it runs (when permission is asked) and once it succeeded. A command's terminal is shown
      // once the call has one.
      const present: Present = (call, outcome, mode = "replay") =>
        Effect.gen(function* () {
          const parsed = parseJson(call.input);
          const input = "value" in parsed && typeof parsed.value === "object" && parsed.value !== null ? (parsed.value as Record<string, unknown>) : {};
          const about = aboutOf(input);
          const base = yield* plain(call, outcome);
          const shown: Presented = { ...base, ...(about === undefined || base.title !== call.tool ? {} : { title: `${call.tool}: ${oneLine(about)}` }) };
          const terminalId = Option.getOrUndefined(HashMap.get(yield* Ref.get(terminals), call.call));
          if (call.tool === "terminal_command") {
            const command = typeof input["command"] === "string" ? ShellCommand.make(input["command"]) : undefined;
            const terminal = terminalId === undefined ? [] : [{ type: "terminal" as const, terminalId }];
            // Before the command has ended, its writes are read, before it runs, and shown from that.
            if (outcome === undefined) {
              const content = [...(yield* writesShown(call.call, command, mode === "live")).flatMap(writeContent), ...terminal];
              return content.length === 0 ? shown : ({ ...shown, content } satisfies Presented);
            }
            // Once it has ended, the files it changed are shown from what it recorded (`changedFiles`); a
            // write it recorded nothing of (its text before was not known, or it was recorded before
            // commands kept their writes) says what it wrote.
            const recorded = new Set<string>(outcome._tag === "Succeeded" ? (outcome.details ?? []).map((detail) => detail.path) : []);
            const unrecorded = outcome._tag === "Succeeded" && command !== undefined ? plannedWrites(command, folders).filter((planned) => planned._tag !== "Planned" || !recorded.has(planned.full)) : [];
            const content = [...changedFiles(outcome), ...unrecorded.map(wroteContent), ...terminal];
            return content.length === 0 ? shown : ({ ...shown, content } satisfies Presented);
          }
          const at = typeof input["path"] === "string" ? { full: fullPathIn(cwd, input["path"]) } : undefined;
          if (at === undefined) return shown;
          const located: Presented = { ...shown, locations: [{ path: at.full }] };
          // A call that recorded what it changed shows its diffs from that (`presentFrom`); one that has not ended, or was recorded before calls kept it, shows its input's.
          if (changedFiles(outcome).length > 0) return located;
          const edited = call.tool === "edit_file" && typeof input["old_text"] === "string" && typeof input["new_text"] === "string";
          return edited && (outcome === undefined || outcome._tag === "Succeeded")
            ? ({ ...located, content: [{ type: "diff", path: at.full, oldText: input["old_text"] as string, newText: input["new_text"] as string }] } satisfies Presented)
            : located;
        });

      return { system: yield* systemFor(cwd, git, additional), sources: [source, ...(git === undefined ? [] : [yield* git.source])], present };
    }),
};

/**
 * A stopgap world: the workspace tools of `agent-tools/workspace.ts` on the local disk under the
 * working folder. It bypasses the editor, so the model does not see unsaved buffers, and the editor
 * is not notified of writes.
 */
export const workspaceWorld: World<FileSystem.FileSystem> = {
  open: ({ cwd, strictInput, environment, additionalFolders }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const additional = additionalFolders ?? [];
      const writtenBy = writtenFiles({ working: WordText.make(cwd), home: WordText.make(homedir()) });
      const workspace = workspaceTools(cwd, { strictInput, additional, writtenBy, ...(environment === undefined ? {} : { environment }) });
      const git = gitToolsAt(cwd, strictInput);
      return {
        system: yield* systemFor(cwd, git, additional),
        sources: [yield* workspace.source.pipe(Effect.provideService(FileSystem.FileSystem, fs)), ...(git === undefined ? [] : [yield* git.source])],
        present: presentFrom([...workspace.catalog, ...(git?.catalog ?? [])]),
      };
    }),
};
