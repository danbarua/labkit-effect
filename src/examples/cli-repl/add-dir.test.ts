/** `/add-dir`: a folder added to the session, listed, refused when it is not a folder, and told to the model once. */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, type FileSystem } from "effect";
import type { CliError } from "effect/cli";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTest } from "../../../tests/support/run.ts";
import { test, testFolder } from "../../../tests/support/test.ts";
import type { Session } from "../../agent-session/loop.ts";
import { makeAddedFolders } from "./added-folders.ts";
import type { CommandContext, Done } from "./command.ts";
import { addDir } from "./commands/add-dir.ts";
import { viewOf } from "./view.ts";

test("/add-dir adds an existing folder for the session, lists the folders added, and refuses a path that is no folder; the model is told once of each folder", async () => {
  const folder = testFolder();
  mkdirSync(join(folder, "shared"), { recursive: true });
  writeFileSync(join(folder, "a.txt"), "a");
  const result = await runTest(
    Effect.gen(function* () {
      const added = yield* makeAddedFolders;
      const context: CommandContext = { folder, configFolder: join(folder, "config"), view: yield* viewOf("on"), layers: [], commandLine: {}, addedFolders: added };
      // /add-dir uses neither the session nor the loop's services: only the file system.
      const run = (words: ReadonlyArray<string>) =>
        (addDir.inSession(undefined as unknown as Session, words, context) as unknown as Effect.Effect<Done, CliError.UserError, FileSystem.FileSystem>).pipe(
          Effect.map((done) => (done._tag === "Said" ? done.text : done._tag)),
          Effect.catchTag("UserError", (error) => Effect.succeed(String(error.userMessage))),
        );
      const printed = [yield* run([]), yield* run(["shared"]), yield* run([join(folder, "shared")]), yield* run(["missing"]), yield* run(["a.txt"]), yield* run([])];
      const first = yield* added.notices.notices;
      const second = yield* added.notices.notices;
      return { printed, first, second };
    }).pipe(Effect.provide(BunServices.layer)),
  );
  const shared = join(folder, "shared");
  expect(result.printed).toEqual([
    "No folders are added. Type /add-dir <folder> to add one.",
    `Added ${shared}: the agent may read and change files there, for this session.`,
    `${shared} is added already.`,
    `ERROR: No such folder: ${join(folder, "missing")}.`,
    `ERROR: Not a folder: ${join(folder, "a.txt")}.`,
    `Added folders:\n  ${shared}`,
  ]);
  expect(result.first).toEqual([`The user added the folder ${shared}: it counts as inside the working folder, so you may read and change files there.`]);
  expect(result.second).toEqual([]);
});
