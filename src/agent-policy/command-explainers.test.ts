/** Plain-English notes on what a command's words do not say plainly: what cannot be undone, the hosts it connects to, what an install runs, paths in full; and notes on the command as a whole. */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { segmentsOf } from "../agent-host/command-parser.ts";
import { commandNotes, notesOf } from "./command-explainers.ts";
import { ShellCommand, WordText } from "./command-segments.ts";
import { type Folders, unitsOf } from "./command-units.ts";

const folders: Folders = { working: WordText.make("/home/someone/play/app"), home: WordText.make("/home/someone") };
/** Each unit's notes, for the units that have any. */
const notes = (command: string): ReadonlyArray<ReadonlyArray<string>> => {
  const split = unitsOf(ShellCommand.make(command), segmentsOf, folders);
  return split._tag === "Units" ? split.units.map((unit) => notesOf(unit, folders)).filter((each) => each.length > 0) : [];
};

test("rm says that it deletes for good, with -r folders and everything in them, and with -f without asking", () => {
  expect(notes("rm a.txt")).toEqual([["It deletes the files it names. Deleted files do not go to the Trash."]]);
  expect(notes("rm -rf build")).toEqual([["It deletes the files and folders it names, with everything in the folders, without asking first. Deleted files do not go to the Trash."]]);
});

test("git's actions that cannot be undone say so; git's other actions say nothing of the kind", () => {
  expect(notes("git reset --hard HEAD~1")).toEqual([["It discards every uncommitted change to the files git tracks. The changes cannot be got back."]]);
  expect(notes("git clean -fd")).toEqual([["It deletes the files and folders that git does not track. They cannot be got back."]]);
  expect(notes("git checkout -- src && git restore --staged a.txt && git branch -D old && git stash drop")).toEqual([
    ["It discards the uncommitted changes to the files it names. They cannot be got back."],
    ["It deletes the branch even when its commits are not merged anywhere."],
    ["It deletes a stashed change. It cannot be got back."],
  ]);
  expect(notes("git push --force-with-lease origin main")).toEqual([
    ["It replaces the remote branch with yours, unless the remote branch changed since you last fetched it. Commits on the remote that yours does not have are lost there.", "It sends your commits to the remote `origin`."],
  ]);
  expect(notes("git reset HEAD a.txt && git checkout main && git status")).toEqual([]);
  expect(notes("chmod -R 755 dist && dd if=img of=/dev/disk4")).toEqual([["With `-R`, `chmod` changes every file and folder inside the folders it names."], ["It writes straight to a device, replacing what is on it."]]);
});

test("a command that connects to a host names it, and says when it sends data", () => {
  expect(notes("curl -s https://example.com/a && curl -X POST -d x=1 https://api.example.com/v1")).toEqual([["It connects to `example.com`."], ["It sends data to `api.example.com`."]]);
  expect(notes("git pull && git clone git@github.com:x/y.git")).toEqual([["It fetches commits from the branch's remote."], ["It downloads a repository from `github.com`."]]);
  expect(notes("ssh build-box && scp a.txt build-box:/tmp/")).toEqual([["It connects to `build-box`."], ["It copies files to or from `build-box`."]]);
});

test("installing packages says what it downloads and runs", () => {
  expect(notes("npm install left-pad && npm ci --ignore-scripts")).toEqual([
    ["It downloads packages from the npm registry and runs their install scripts, which can run any code on this machine."],
    ["It downloads packages from the npm registry, without running their install scripts."],
  ]);
  expect(notes("python3 -m pip install requests")).toEqual([["It downloads packages from the package index. A package built from source runs its build code, which can run any code on this machine."]]);
  expect(notes("brew install jq && bun test")).toEqual([["It installs software for your whole user account, outside the working folder."]]);
});

test("a path outside the working folder written relatively is given in full; an absolute one or one not written out is not", () => {
  expect(notes("cat ../lib/secret.txt ~/notes.md /etc/hosts")).toEqual([["`../lib/secret.txt` is `/home/someone/play/lib/secret.txt`.", "`~/notes.md` is `/home/someone/notes.md`."]]);
  expect(notes('rm -f "$DIR"/x')).toEqual([["It deletes the files it names, without asking first. Deleted files do not go to the Trash."]]);
});

test("the command's notes: a pipeline's exit status is its last program's, unless pipefail is set first; and what the session grants offered cover", () => {
  const of = (command: string, grants: ReadonlyArray<ReadonlyArray<string>> = []) =>
    commandNotes(ShellCommand.make(command), segmentsOf, grants.map((grant) => grant.map((word) => WordText.make(word)))) as ReadonlyArray<string>;
  expect(of("bun test | tail -20")).toEqual(["Only `tail`'s exit status counts: the pipeline from `bun` to `tail` succeeds when `tail` does, even if `bun` fails."]);
  expect(of("set -o pipefail; bun test | tail -20")).toEqual([]);
  expect(of("rm -rf build", [["rm"]])).toEqual(["Allowing `rm` for the rest of the session lets later `rm` commands run without a question inside the working folder. Outside it, they are still asked about."]);
  expect(of("mkdir out && cp a out", [["mkdir"], ["cp"]])).toEqual([
    "Allowing `mkdir` and `cp` for the rest of the session lets later commands that use them run without a question inside the working folder. Outside it, they are still asked about.",
  ]);
  // A program whose paths are not judged is not asked about outside the working folder either, and the note says so.
  expect(of("bun test && rm -rf build", [["bun", "test"], ["rm"]])).toEqual([
    "Allowing `rm` for the rest of the session lets later `rm` commands run without a question inside the working folder. Outside it, they are still asked about.",
    "Allowing `bun test` for the rest of the session lets later `bun test` commands run without a question. labkit does not see which files it reads or writes itself, so it does not ask about them, even outside the working folder.",
  ]);
});
