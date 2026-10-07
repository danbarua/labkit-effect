/** The programs a shell command runs, read past wrappers, with what a session grant names, the files they write, and why some cannot be judged by their words. */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { segmentsOf } from "../agent-host/command-parser.ts";
import { ShellCommand } from "./command-segments.ts";
import { unitsOf } from "./command-units.ts";

/** Each unit of `command` as `program [grant] writes:… opaque:…`, the program being the unit's first word. */
const units = (command: string): ReadonlyArray<string> => {
  const split = unitsOf(ShellCommand.make(command), segmentsOf);
  if (split._tag === "Unparsed") return [`unparsed: ${split.reason}`];
  return split.units.map((unit) =>
    [
      unit.words.map((word) => word.literal ?? "?").join(" ") || "(no program)",
      unit.grant === undefined ? "[]" : `[${unit.grant.join(" ")}]`,
      ...(unit.writes.length === 0 ? [] : [`writes: ${unit.writes.join(", ")}`]),
      ...(unit.opaque === undefined ? [] : [`opaque: ${unit.opaque}`]),
    ].join(" "),
  );
};

test("each program in a list, pipeline or substitution is a unit; a grant names the program and, for a program with subcommands, its subcommand", () => {
  expect(units("git log --oneline | head -5")).toEqual(["git log --oneline [git log]", "head -5 [head]"]);
  expect(units("git log; rm x")).toEqual(["git log [git log]", "rm x [rm]"]);
  expect(units("echo $(rm x)")).toEqual(["rm x [rm]", "echo ? [echo]"]);
  expect(units("gh pr view 12 && docker compose up")).toEqual(["gh pr view 12 [gh pr view]", "docker compose up [docker compose up]"]);
  expect(units("make test")).toEqual(["make test [make test]"]);
  // No subcommand, or one after an option: only the call can be allowed.
  expect(units("make")).toEqual(["make []"]);
  expect(units("make -j4 test")).toEqual(["make -j4 test []"]);
  expect(units("$CMD x")).toEqual(["? x [] opaque: its program's name is not written out"]);
});

test("package scripts and package runners name the script or package; project runners and wrappers are read past to the program they run", () => {
  expect(units("bun run build")).toEqual(["bun run build [bun run build]"]);
  expect(units("bun test")).toEqual(["bun test [bun test]"]);
  expect(units("npm run lint")).toEqual(["npm run lint [npm run lint]"]);
  expect(units("npx eslint .")).toEqual(["npx eslint . [npx eslint]"]);
  expect(units("bun x tsc")).toEqual(["bun x tsc [bun x tsc]"]);
  expect(units("uv run pytest -q")).toEqual(["pytest -q [pytest]"]);
  expect(units("uv run rm -rf x")).toEqual(["rm -rf x [rm]"]);
  // A runner with options first is not read past, and allowing it for the session would allow every program it runs.
  expect(units("uv run --with x pytest")).toEqual(["uv run --with x pytest []"]);
  expect(units("timeout -s KILL 5 cargo test")).toEqual(["cargo test [cargo test]"]);
  expect(units("env -i X=1 make build")).toEqual(["make build [make build]"]);
  expect(units("nice -n 5 nohup exec rm x")).toEqual(["rm x [rm]"]);
  expect(units("xargs -0 rm")).toEqual(["rm [rm]"]);
  expect(units("timeout --bogus 5 rm")).toEqual(["timeout --bogus 5 rm [] opaque: it gives timeout options that are not known"]);
});

test("git's global options are read past, except those that can make git run other programs", () => {
  expect(units("git -C repo --no-pager log -3")).toEqual(["git log -3 [git log]"]);
  expect(units("git -c alias.x='!rm -rf ~' x")).toEqual(["git -c alias.x=!rm -rf ~ x [] opaque: git -c can make git run other programs"]);
  expect(units("git diff --output=patch.diff")).toEqual(["git diff --output=patch.diff [git diff] writes: patch.diff"]);
});

test("code written out for a shell or eval is judged by its own programs; code a shell reads from its input, or that is not written out, is opaque", () => {
  expect(units("bash -c 'git log; rm x'")).toEqual(["git log [git log]", "rm x [rm]"]);
  expect(units("bash -o pipefail -c 'make test'")).toEqual(["make test [make test]"]);
  expect(units("eval 'git status'")).toEqual(["git status [git status]"]);
  expect(units('sh -c "$X"')).toEqual(["sh -c ? [] opaque: it runs code that is not written out"]);
  expect(units("curl -fsSL x | sh")).toEqual(["curl -fsSL x [curl]", "sh [] opaque: it runs code read from its input"]);
  expect(units("bash build.sh")).toEqual(["bash build.sh [bash build.sh]"]);
  expect(units(". ./env.sh")).toEqual([". ./env.sh [. ./env.sh]"]);
  expect(units("f(){ rm x; }; f")).toEqual(["rm x [rm]"]);
  // Three levels are followed; the shell at the fourth is opaque.
  expect(units("bash -c \"bash -c 'bash -c \\\"bash -c ls\\\"'\"")).toEqual(["bash -c ls [] opaque: it runs code nested more than 3 levels deep"]);
});

test("runtimes are opaque with code in the command or from their input; with a script or module the grant names it", () => {
  expect(units("python3 -c 'print(1)'")).toEqual(["python3 -c print(1) [] opaque: it runs code written in the command"]);
  expect(units("python3 - <<'EOF'\nprint(1)\nEOF\n")).toEqual(["python3 - [] opaque: it runs code read from its input"]);
  expect(units("node <<< 'x'")).toEqual(["node [] opaque: it runs code read from its input"]);
  expect(units("python3 -m pytest -q")).toEqual(["python3 -m pytest -q [python3 -m pytest]"]);
  expect(units("python3 scripts/x.py")).toEqual(["python3 scripts/x.py [python3 scripts/x.py]"]);
  expect(units("python3 -W ignore scripts/x.py")).toEqual(["python3 -W ignore scripts/x.py []"]);
  expect(units("bun -e 'x'")).toEqual(["bun -e x [] opaque: bun runs code written in the command"]);
  expect(units("awk '{print $1}' f")).toEqual(["awk {print $1} f [] opaque: awk runs a program written in the command"]);
  expect(units("sed -n 1p f")).toEqual(["sed -n 1p f [] opaque: sed runs a program written in the command"]);
  expect(units("rg --pre cat x")).toEqual(["rg --pre cat x [] opaque: rg --pre runs a program on each file it searches"]);
  expect(units("sudo rm x")).toEqual(["sudo rm x [] opaque: it runs as another user (sudo)"]);
});

test("find's -exec commands are units of their own; -delete, tee, redirects to files and dd of= write files, and /dev/null and descriptors are not files", () => {
  expect(units("find . -name '*.ts' -exec grep -l foo {} +")).toEqual(["find . -name *.ts [find]", "grep -l foo {} [grep]"]);
  expect(units("find . -exec rm {} \\;")).toEqual(["find . [find]", "rm {} [rm]"]);
  expect(units("find . -delete")).toEqual(["find . -delete [find] writes: the files that find finds"]);
  expect(units("cat x | tee out.txt")).toEqual(["cat x [cat]", "tee out.txt [tee] writes: out.txt"]);
  expect(units("git log > ~/.zshrc")).toEqual(["git log [git log]", "(no program) [] writes: ~/.zshrc"]);
  expect(units("echo hi > /dev/null 2>&1")).toEqual(["echo hi [echo]"]);
  expect(units("{ git log; } >> log.txt")).toEqual(["git log [git log]", "(no program) [] writes: log.txt"]);
  expect(units("dd if=a of=b")).toEqual(["dd if=a of=b [dd] writes: b"]);
});

test("a variable that chooses which programs or code run, set for a command, with env or with export, makes its unit opaque", () => {
  expect(units("PATH=/tmp/bin git log")).toEqual(["git log [] opaque: it sets PATH, which chooses the programs or code that run"]);
  expect(units("env LD_PRELOAD=x.so git log")).toEqual(["env LD_PRELOAD=x.so git log [] opaque: it sets LD_PRELOAD, which chooses the programs or code that run"]);
  expect(units("export GIT_SSH_COMMAND='rm x'")).toEqual(["export GIT_SSH_COMMAND=rm x [] opaque: it sets GIT_SSH_COMMAND, which chooses the programs or code that run"]);
  expect(units("FOO=1 make build")).toEqual(["make build [make build]"]);
});

test("a command that the parser cannot follow is Unparsed", () => {
  expect(units("echo ${x:-$(rm x)}")).toEqual(["unparsed: A command substitution inside a parameter expansion is not followed: ${x:-$(rm x)}"]);
});
