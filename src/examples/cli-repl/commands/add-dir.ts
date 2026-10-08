/**
 * `/add-dir <folder>` adds a folder to this session: from the next tool call on, the agent may read
 * and change files there as it does in the working folder, and the model is told of it. The folder is
 * absolute, from `~`, or relative to the working folder, and must exist. `/add-dir` alone lists the
 * folders added.
 *
 * The folder is recorded as a fact of the session (`FolderAdded`), so it stays added when the session
 * is continued. The settings' `additionalDirectories` and `--add-dir` add folders for every session.
 */

import { Effect, FileSystem } from "effect";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { FolderPath } from "../../../agent-machine/names.ts";
import { foldersAddedOf } from "../../../agent-session/configuration/session-setup.ts";
import { type ReplCommand, said } from "../command.ts";
import { invalid } from "../invalid.ts";

export const addDir: ReplCommand = {
  name: "/add-dir",
  args: "[folder]",
  says: "Let the agent read and change files in another folder, for this session",
  inSession: (session, words, context) =>
    Effect.gen(function* () {
      const added = foldersAddedOf(yield* session.facts);
      const [given] = words;
      if (given === undefined) {
        return said(added.length === 0 ? "No folders are added. Type /add-dir <folder> to add one." : `Added folders:\n${added.map((folder) => `  ${folder}`).join("\n")}`);
      }
      const folder = FolderPath.make(given === "~" || given.startsWith("~/") ? join(homedir(), given.slice(1)) : resolve(context.folder, given));
      if (added.includes(folder)) return said(`${folder} is added already.`);
      const fs = yield* FileSystem.FileSystem;
      const info = yield* fs.stat(folder).pipe(Effect.option);
      if (info._tag === "None") return yield* invalid(`No such folder: ${folder}.`);
      if (info.value.type !== "Directory") return yield* invalid(`Not a folder: ${folder}.`);
      yield* session.observe({ _tag: "FolderAdded", folder });
      return said(`Added ${folder}: the agent may read and change files there, for this session.`);
    }),
};
