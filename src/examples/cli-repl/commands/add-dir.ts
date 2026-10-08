/**
 * `/add-dir <folder>` adds a folder to this session: from the next tool call on, the agent may read
 * and change files there as it does in the working folder, and the model is told of it. The folder is
 * absolute, from `~`, or relative to the working folder, and must exist. `/add-dir` alone lists the
 * folders added. A folder added here lasts for the session; the settings' `additionalDirectories`
 * and `--add-dir` add folders for every session.
 */

import { Effect, FileSystem } from "effect";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type ReplCommand, said } from "../command.ts";
import { invalid } from "../invalid.ts";

export const addDir: ReplCommand = {
  name: "/add-dir",
  args: "[folder]",
  says: "Let the agent read and change files in another folder, for this session",
  inSession: (_session, words, context) =>
    Effect.gen(function* () {
      const added = context.addedFolders;
      if (added === undefined) return yield* invalid("This session cannot add folders.");
      const [given] = words;
      if (given === undefined) {
        const all = yield* added.list;
        return said(all.length === 0 ? "No folders are added. Type /add-dir <folder> to add one." : `Added folders:\n${all.map((folder) => `  ${folder}`).join("\n")}`);
      }
      const folder = given === "~" || given.startsWith("~/") ? join(homedir(), given.slice(1)) : resolve(context.folder, given);
      const fs = yield* FileSystem.FileSystem;
      const info = yield* fs.stat(folder).pipe(Effect.option);
      if (info._tag === "None") return yield* invalid(`No such folder: ${folder}.`);
      if (info.value.type !== "Directory") return yield* invalid(`Not a folder: ${folder}.`);
      const isNew = yield* added.add(folder);
      return said(isNew ? `Added ${folder}: the agent may read and change files there, for this session.` : `${folder} is added already.`);
    }),
};
