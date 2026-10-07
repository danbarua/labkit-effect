/** The files a command writes text to, resolved against the working folder, and their current text read before it runs. */

import { expect } from "bun:test";
import { Effect, FileSystem } from "effect";
import { BunServices } from "@effect/platform-bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, testFolder } from "../../tests/support/test.ts";
import { ShellCommand, WordText } from "../agent-policy/command-segments.ts";
import { type Current, currentOnDisk, plannedWrites, shownWrites } from "./command-writes.ts";

const folders = { working: WordText.make("/home/someone/project"), home: WordText.make("/home/someone") };
const planned = (command: string) => plannedWrites(ShellCommand.make(command), folders).map((each) => (each._tag === "Planned" ? `${each.full} ← ${JSON.stringify(each.writes.text)}` : `${each.writes.path}: ${each.reason}`));

test("a write's path is resolved against the working folder, and ~ against the home folder", () => {
  expect(planned("cat > config.yml <<'EOF'\nname: x\nEOF")).toEqual(['/home/someone/project/config.yml ← "name: x\\n"']);
  expect(planned("echo hi >> ~/notes.txt && echo -n x > ../sibling/a.txt")).toEqual(['/home/someone/notes.txt ← "hi\\n"', '/home/someone/sibling/a.txt ← "x"']);
});

test("a write after a cd, or to another user's home folder, is not planned as a diff, with why", () => {
  expect(planned("cd src && echo hi > a.txt")).toEqual(["a.txt: a cd earlier in the command may change which file it writes"]);
  expect(planned("echo hi > ~root/a.txt")).toEqual(["~root/a.txt: its path names another user's home folder"]);
});

test("the diff of an addition is the current text with the new text at its end; a file whose text is not known is shown without a diff", async () => {
  const currents: Record<string, Current> = {
    "/home/someone/project/log.txt": { _tag: "Text", text: "one\n" },
    "/home/someone/project/new.txt": { _tag: "Missing" },
    "/home/someone/project/big.txt": { _tag: "Unknown", reason: "it is larger than 256 KiB" },
  };
  const shown = await Effect.runPromise(
    shownWrites(ShellCommand.make("echo two >> log.txt; echo x > new.txt; echo y > big.txt"), folders, (full) => Effect.succeed(currents[full] ?? { _tag: "Missing" })),
  );
  expect(shown.map((each) => (each._tag === "Diff" ? [each.full, each.before, each.after] : [each.writes.path, each.reason]))).toEqual([
    ["/home/someone/project/log.txt", "one\n", "one\ntwo\n"],
    ["/home/someone/project/new.txt", undefined, "x\n"],
    ["big.txt", "it is larger than 256 KiB"],
  ]);
});

test("on the disk, a missing file is new, a file has its text, and a folder is not a file", async () => {
  const folder = testFolder();
  mkdirSync(join(folder, "dir"), { recursive: true });
  writeFileSync(join(folder, "a.txt"), "alpha\n");
  const read = (name: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* currentOnDisk(yield* FileSystem.FileSystem, join(folder, name), name);
      }).pipe(Effect.provide(BunServices.layer)),
    );
  expect(await read("missing.txt")).toEqual({ _tag: "Missing" });
  expect(await read("a.txt")).toEqual({ _tag: "Text", text: "alpha\n" });
  expect(await read("dir")).toEqual({ _tag: "Unknown", reason: "it is not a file" });
});
