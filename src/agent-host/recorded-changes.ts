/**
 * What a host's own tools change in files, recorded where their calls run (`recordingChanges`, a
 * wrapper around a tool source), so that every tool's changes are read in one place and under one
 * limit (`FileChanged`, `ToolDetail`). The files a call changes are found as the permission policy
 * finds them:
 *
 * | Tool | Files |
 * | --- | --- |
 * | a command tool (the permission settings' `commandTools`) | each file whose text its command writes, where its words show the path (`writtenFiles`): a redirect's target, `tee`'s, `sed -i`'s; and each move its `mv`s make (`plannedMoves`) |
 * | a tool whose kind changes files (`edit`, `delete`, `move`; `editsFiles`) | each file its path inputs name (`ToolSpec.paths`), resolved from the working folder as the tools resolve them (`fullPathIn`) |
 *
 * Each file's text is read just before the call runs and, once the call has succeeded, again: a
 * command's from the disk, which a command writes; a path input's through the world's reader, told
 * which of the two reads it is (in the editor world, the editor's text, unsaved changes included,
 * with whether the file exists before the call from the disk), else from the disk. A text over 256
 * KiB (`maxCurrentBytes`), or one that could not be read, is not known, so nothing is recorded of its
 * file, and a warning says so. The patch is cut at 32 KiB (`fileChanged`). A move is recorded as
 * `FileMoved`, not as text: the disk is checked before the call (the source is there; where it goes,
 * into a folder the destination names or to the destination itself, and whether something is there)
 * and after it (the source is gone, and something is where it went). A failed call records nothing. An MCP server's tool source is not wrapped: the operator who installs a server trusts it.
 */

import { basename, join } from "node:path";
import { Effect, FileSystem } from "effect";
import { FullPath, type ToolName } from "../agent-machine/names.ts";
import type { ToolDetail } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";
import type { Folders } from "../agent-policy/command-units.ts";
import { editsFiles } from "../agent-policy/permissions.ts";
import { logKeys } from "../agent-session/log-keys.ts";
import { parseJson } from "../agent-session/received.ts";
import type { ToolSource } from "../agent-session/tool-sources.ts";
import { type Current, currentOnDisk, fileChanged, maxCurrentBytes } from "../agent-tools/file-change.ts";
import { fullPathIn } from "../agent-tools/paths.ts";
import { type PlannedMove, plannedMoves, writtenFiles } from "./command-writes.ts";

export interface Recording {
  /** The working folder, from which a relative path input is resolved. */
  readonly root: string;
  /** The folders a command's paths are resolved against (`writtenFiles`). */
  readonly folders: Folders;
  /** The command tools' names (the permission settings' `commandTools`). */
  readonly commandTools: ReadonlyArray<string>;
  /** A path input's file text before or after the call, as the world's tools read and write it; from the disk when left out. */
  readonly fileText?: ((full: string, when: "before" | "after") => Effect.Effect<Current>) | undefined;
}

/** A file a call changes, and how its text is read before and after the call. */
interface Changed {
  readonly full: string;
  readonly read: (full: string, when: "before" | "after") => Effect.Effect<Current>;
}

/** A candidate move as the disk showed it before the call: the source, where it would go, and whether something was there. */
interface MoveBefore {
  readonly from: string;
  readonly to: string;
  readonly occupied: boolean;
}

/** `current`, or not known when its text is over `maxCurrentBytes`. */
const capped = (current: Current): Current =>
  current._tag === "Text" && Buffer.byteLength(current.text) > maxCurrentBytes ? { _tag: "Unknown", reason: `it is larger than ${maxCurrentBytes / 1024} KiB` } : current;

/** Returns `source` recording what its calls change in files (see the module's comment). */
export const recordingChanges =
  (recording: Recording) =>
  (source: ToolSource): Effect.Effect<ToolSource, never, FileSystem.FileSystem> =>
    Effect.map(FileSystem.FileSystem, (fs) => {
      const disk = (full: string) => currentOnDisk(fs, full, full);
      const written = writtenFiles(recording.folders);
      const moving = plannedMoves(recording.folders);
      /** The command in a command tool's `input`; undefined for any other tool, or input with no command. */
      const commandOf = (tool: ToolName, input: Received): string | undefined => {
        if (!recording.commandTools.includes(tool)) return undefined;
        const parsed = parseJson(input);
        const command = "value" in parsed && typeof parsed.value === "object" && parsed.value !== null ? (parsed.value as Readonly<Record<string, unknown>>)["command"] : undefined;
        return typeof command === "string" ? command : undefined;
      };
      /** Whether something is at `full`; a check that fails is warned of, and counts as unknown. */
      const there = (tool: ToolName, full: string): Effect.Effect<boolean | undefined> =>
        fs.exists(full).pipe(Effect.catch((error) => Effect.logWarning(logKeys.tools.changeNotRecorded, { tool, full, reason: `it could not be checked: ${error.message}` }).pipe(Effect.as(undefined))));
      /** Before the call: where a candidate move's source would go, and whether something is there; undefined when its source is not there to move, or the disk could not be read. */
      const beforeMove = (tool: ToolName, move: PlannedMove): Effect.Effect<MoveBefore | undefined> =>
        Effect.gen(function* () {
          if ((yield* there(tool, move.from)) !== true) return undefined;
          const destination = yield* there(tool, move.destination);
          if (destination === undefined) return undefined;
          const kind = destination
            ? yield* fs.stat(move.destination).pipe(
                Effect.map((info) => info.type),
                Effect.catch((error) => Effect.logWarning(logKeys.tools.changeNotRecorded, { tool, full: move.destination, reason: `it could not be checked: ${error.message}` }).pipe(Effect.as(undefined))),
              )
            : "Missing";
          if (kind === undefined) return undefined;
          const to = move.into || kind === "Directory" ? join(move.destination, basename(move.from)) : move.destination;
          const occupied = yield* there(tool, to);
          return occupied === undefined ? undefined : { from: move.from, to, occupied };
        });
      /** After the call: the move, when the source is gone and something is where it went. */
      const afterMove = (tool: ToolName, move: MoveBefore): Effect.Effect<ReadonlyArray<ToolDetail>> =>
        Effect.gen(function* () {
          const [left, arrived] = [yield* there(tool, move.from), yield* there(tool, move.to)];
          return left === false && arrived === true ? [{ _tag: "FileMoved", from: FullPath.make(move.from), to: FullPath.make(move.to), ...(move.occupied ? { replaced: true as const } : {}) }] : [];
        });
      /** The files that a call to `tool` with `input` changes, each once. */
      const changedBy = (tool: ToolName, input: Received): ReadonlyArray<Changed> => {
        const parsed = parseJson(input);
        // A tool's input is a JSON object; anything else names no file.
        const given = ("value" in parsed && typeof parsed.value === "object" && parsed.value !== null && !Array.isArray(parsed.value) ? parsed.value : {}) as Readonly<Record<string, unknown>>;
        if (recording.commandTools.includes(tool)) {
          const command = given["command"];
          return typeof command === "string" ? written(command).map((full) => ({ full, read: disk })) : [];
        }
        const spec = source.tools.find((each) => each.name === tool);
        if (spec === undefined || !editsFiles.includes(spec.kind)) return [];
        const fulls = (spec.paths ?? []).flatMap((name) => {
          const path = given[name];
          return typeof path === "string" && path !== "" ? [fullPathIn(recording.root, path)] : [];
        });
        return [...new Set(fulls)].map((full) => ({ full, read: recording.fileText ?? disk }));
      };
      /** `current` of the file at `full` for the call `call`, warned of when it is not known. */
      const known = (current: Current, tool: ToolName, full: string): Effect.Effect<Current> =>
        current._tag === "Unknown" ? Effect.logWarning(logKeys.tools.changeNotRecorded, { tool, full, reason: current.reason }).pipe(Effect.as(current)) : Effect.succeed(current);
      return {
        ...source,
        run: (tool, input, call) =>
          Effect.gen(function* () {
            const files = changedBy(tool, input);
            const command = commandOf(tool, input);
            const moves = command === undefined ? [] : moving(command);
            if (files.length === 0 && moves.length === 0) return yield* source.run(tool, input, call);
            const before = yield* Effect.forEach(files, (file) => Effect.flatMap(file.read(file.full, "before"), (text) => Effect.map(known(capped(text), tool, file.full), (current) => ({ ...file, before: current }))));
            const movesBefore = (yield* Effect.forEach(moves, (move) => beforeMove(tool, move))).flatMap((move) => (move === undefined ? [] : [move]));
            const outcome = yield* source.run(tool, input, call);
            if (outcome._tag !== "Succeeded") return outcome;
            const details = yield* Effect.forEach(before, (file) =>
              file.before._tag === "Unknown"
                ? Effect.succeed([])
                : Effect.flatMap(file.read(file.full, "after"), (text) => Effect.map(known(capped(text), tool, file.full), (after) => (after._tag === "Text" ? fileChanged(file.full, file.before, after.text) : []))),
            );
            const moved = yield* Effect.forEach(movesBefore, (move) => afterMove(tool, move));
            const all = [...(outcome.details ?? []), ...details.flat(), ...moved.flat()];
            return all.length === 0 ? outcome : { ...outcome, details: all };
          }).pipe(Effect.annotateLogs({ call })),
      };
    });
