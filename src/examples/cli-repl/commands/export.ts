/**
 * `/export` writes the session's transcript (`markdownOf`) to `.<brand>/exports/<session>.md` in the
 * folder the CLI runs in (`.labkit/` for labkit's), as the ACP host's `/export` does.
 */

import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { Brand, folderOf } from "../../../agent-host/brand.ts";
import { markdownOf } from "../../../agent-host/export.ts";
import { type ReplCommand, said } from "../command.ts";
import { invalid } from "../invalid.ts";

export const exportCommand: ReplCommand = {
  name: "/export",
  says: "Write this session's transcript as Markdown to .<brand>/exports/<session>.md",
  inSession: (session, _words, { folder }) =>
    Effect.gen(function* () {
      const facts = yield* session.facts;
      const opened = facts[0];
      const id = opened?._tag === "Observed" && opened.observation._tag === "SessionOpened" ? opened.observation.session : "session";
      const exports = join(folder, folderOf(yield* Brand), "exports");
      const path = join(exports, `${id}.md`);
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(exports, { recursive: true }).pipe(Effect.andThen(fs.writeFileString(path, markdownOf(facts))), Effect.mapError((error) => invalid(`The transcript could not be written to ${path}: ${error.message}`)));
      return said(`Exported this session to ${path}`);
    }),
};
