/** The programs a shell command runs, read past wrappers, with what a session grant names, the files they write, and why some cannot be judged by their words. */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { segmentsOf } from "../agent-host/command-parser.ts";
import { ShellCommand, WordText } from "./command-segments.ts";
import { unitsOf } from "./command-units.ts";

/** Each unit of `command` as `program [grant] writes:… changes outside:… opaque:…`, the program being the unit's first word. */
const units = (command: string): ReadonlyArray<string> => {
  const split = unitsOf(ShellCommand.make(command), segmentsOf);
  if (split._tag === "Unparsed") return [`unparsed: ${split.reason}`];
  return split.units.map((unit) =>
    [
      unit.words.map((word) => word.literal ?? "?").join(" ") || "(no program)",
      unit.grant === undefined ? "[]" : `[${unit.grant.join(" ")}]`,
      ...(unit.writes.length === 0 ? [] : [`writes: ${unit.writes.join(", ")}`]),
      ...(unit.changesOutside.length === 0 ? [] : [`changes outside: ${unit.changesOutside.map((change) => `${change.verb} ${change.path ?? "(its input)"}`).join(", ")}`]),
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
  expect(units("xargs -0 rm")).toEqual(["rm [rm] changes outside: deletes (its input)"]);
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
  expect(units("rg --pre cat x")).toEqual(["rg --pre cat x [] opaque: rg --pre runs a program on each file it searches"]);
  expect(units("sudo rm x")).toEqual(["sudo rm x [] opaque: it runs as another user (sudo)"]);
});

test("find's -exec commands are units of their own; -delete, tee, redirects to files and dd of= write files, and /dev/null and descriptors are not files", () => {
  expect(units("find . -name '*.ts' -exec grep -l foo {} +")).toEqual(["find . -name *.ts [find]", "grep -l foo {} [grep]"]);
  expect(units("find . -exec rm {} \\;")).toEqual(["find . [find]", "rm {} [rm]"]);
  expect(units("find . -delete")).toEqual(["find . -delete [find] writes: the files that find finds"]);
  expect(units("cat x | tee out.txt")).toEqual(["cat x [cat]", "tee out.txt [tee] writes: out.txt"]);
  expect(units("git log > ~/.zshrc")).toEqual(["git log [git log]", "(no program) [] changes outside: writes ~/.zshrc"]);
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

test("commands that trap or git would run are judged or opaque, so that no grant names more than the user saw; ssh is trusted per host", () => {
  expect(units("trap 'rm -rf build' EXIT; make")).toEqual(["rm -rf build [rm]", "make []"]);
  expect(units('trap "$X" EXIT')).toEqual(["trap ? EXIT [] opaque: trap runs code that is not written out"]);
  expect(units("git rebase -x 'make test' main")).toEqual(["git rebase -x make test main [] opaque: git rebase --exec runs a command for each commit"]);
  expect(units("git submodule foreach git pull")).toEqual(["git submodule foreach git pull [] opaque: git submodule foreach runs a command in each submodule"]);
  expect(units("git bisect run make test")).toEqual(["git bisect run make test [] opaque: git bisect run runs a command for each step"]);
  expect(units("npm x eslint && yarn exec tsc")).toEqual(["npm x eslint [npm x eslint]", "yarn exec tsc [yarn exec tsc]"]);
  // ssh, like docker and kubectl, is trusted as a whole: the command it runs on the host is not judged.
  expect(units("ssh -p 2222 build-box 'rm -rf /srv'")).toEqual(["ssh -p 2222 build-box rm -rf /srv [ssh build-box]"]);
  expect(units("docker exec web ls")).toEqual(["docker exec web ls [docker exec web]"]);
});

test("a command that the parser cannot follow is Unparsed", () => {
  expect(units("echo ${x:-$(rm x)}")).toEqual(["unparsed: A command substitution inside a parameter expansion is not followed: ${x:-$(rm x)}"]);
});

/** Each unit of `command` as `program outside: …` when it reads outside the working folder. */
const outside = (command: string): ReadonlyArray<string> => {
  const split = unitsOf(ShellCommand.make(command), segmentsOf);
  return split._tag === "Units" ? split.units.map((unit) => `${unit.words[0]?.literal ?? "?"}${unit.outside.length === 0 ? "" : ` outside: ${unit.outside.join(", ")}`}`) : [];
};

test("a read-only program's paths outside the working folder are found: absolute, through .. or ~, or not written out; a pattern or text is not a path", () => {
  expect(outside("cat ~/.aws/credentials")).toEqual(["cat outside: ~/.aws/credentials"]);
  expect(outside("grep -r token / && grep '/usr/bin' notes.txt")).toEqual(["grep outside: /", "grep"]);
  expect(outside("grep -f /etc/patterns src")).toEqual(["grep outside: /etc/patterns"]);
  expect(outside("ls src ../other; head -n 5 a.txt; echo /etc/passwd")).toEqual(["ls outside: ../other", "head", "echo"]);
  expect(outside('cat "$HOME/x" src/*.ts')).toEqual(['cat outside: "$HOME/x"']);
  expect(outside("cd; cd -; cd src/../..; cd src")).toEqual(["cd outside: ~", "cd outside: -", "cd outside: src/../..", "cd"]);
  expect(outside("git -C ~/other log && git diff --no-index /tmp/a b")).toEqual(["git outside: ~/other", "git outside: /tmp/a"]);
});

test("sed is judged by its script: opaque when it runs commands, is in a file or is not understood; otherwise granted as sed, with the files it writes and reads", () => {
  expect(units("sed -n 1p f")).toEqual(["sed -n 1p f [sed]"]);
  expect(units("sed 's/x/y/e' f")).toEqual(["sed s/x/y/e f [] opaque: sed's script runs commands (e)"]);
  expect(units("sed -i 's/a/b/' f.txt")).toEqual(["sed -i s/a/b/ f.txt [sed] writes: f.txt"]);
  expect(units("sed -i '' 's/a/b/' f.txt")).toEqual(["sed -i  s/a/b/ f.txt [sed] writes: f.txt"]);
  expect(units("sed -e 's/a/b/w out.txt' -e p f")).toEqual(["sed -e s/a/b/w out.txt -e p f [sed] writes: out.txt"]);
  expect(units("sed -f fix.sed f")).toEqual(["sed -f fix.sed f [] opaque: sed runs a script from a file"]);
  expect(units("sed \"$S\" f")).toEqual(["sed ? f [] opaque: sed's script is not written out, or is not understood"]);
  expect(outside("sed -n p /etc/passwd; sed 'r /etc/hosts' f")).toEqual(["sed outside: /etc/passwd", "sed outside: /etc/hosts"]);
});

test("with the working and home folders known, an absolute path or one from ~ is outside only when it leaves the working folder; a relative one only when its .. climb above it", () => {
  const folders = { working: WordText.make("/home/dan/project"), home: WordText.make("/home/dan") };
  const split = unitsOf(ShellCommand.make("cat /home/dan/project/src/a.ts /home/dan/project/../x ~/notes ~/project/b src/../c src/../../d /home/dan/projects-old/e"), segmentsOf, folders);
  expect((split._tag === "Units" ? split.units[0]?.outside : []) as unknown).toEqual(["/home/dan/project/../x", "~/notes", "src/../../d", "/home/dan/projects-old/e"]);
  const home = unitsOf(ShellCommand.make("cd"), segmentsOf, { working: WordText.make("/home/dan"), home: WordText.make("/home/dan") });
  expect((home._tag === "Units" ? home.units[0]?.outside : []) as unknown).toEqual([]);
});

/** The detail of each unit of `command` that has one, as the unit's program and its detail. */
const details = (command: string): ReadonlyArray<unknown> => {
  const split = unitsOf(ShellCommand.make(command), segmentsOf);
  if (split._tag === "Unparsed") return [`unparsed: ${split.reason}`];
  return split.units.flatMap((unit) => (unit.detail === undefined ? [] : [[unit.words[0]?.literal, unit.detail]]));
};

test("code written in the command is shown in its language: inline options, including at the end of a cluster (perl -ne), awk's program, and bun and deno", () => {
  expect(details("python3 -c 'import sys; print(sys.argv)'")).toEqual([["python3", { _tag: "Code", language: "python", code: "import sys; print(sys.argv)" }]]);
  expect(details("node -e 'console.log(1)'")).toEqual([["node", { _tag: "Code", language: "javascript", code: "console.log(1)" }]]);
  expect(details("perl -ne 'print if /x/' f")).toEqual([["perl", { _tag: "Code", language: "perl", code: "print if /x/" }]]);
  expect(details("ruby -pe 'gsub(/a/, \"b\")' f")).toEqual([["ruby", { _tag: "Code", language: "ruby", code: 'gsub(/a/, "b")' }]]);
  expect(details("awk -F: -v n=1 '{print $n}' /etc/passwd")).toEqual([["awk", { _tag: "Code", language: "awk", code: "{print $n}" }]]);
  expect(details("bun -e 'console.log(1)'")).toEqual([["bun", { _tag: "Code", language: "typescript", code: "console.log(1)" }]]);
  expect(details("deno eval 'console.log(1)'")).toEqual([["deno", { _tag: "Code", language: "typescript", code: "console.log(1)" }]]);
  // Code that is not written out has nothing to show.
  expect(details('python3 -c "$CODE"')).toEqual([]);
});

test("a program reading code from a here-document or here-string shows that code, in the program's language; a shell's is bash", () => {
  expect(details("python3 - <<'EOF'\nimport sys\nprint(sys.argv)\nEOF")).toEqual([["python3", { _tag: "Code", language: "python", code: "import sys\nprint(sys.argv)" }]]);
  expect(details("bash <<'EOF'\nrm -rf build\nEOF")).toEqual([["bash", { _tag: "Code", language: "bash", code: "rm -rf build" }]]);
  expect(details("node <<< 'console.log(1)'")).toEqual([["node", { _tag: "Code", language: "javascript", code: "console.log(1)" }]]);
});

test("a sed call carries its explanation, whether it is granted as sed or runs commands", () => {
  expect(details("sed -n '/x/p' f")).toEqual([["sed", { _tag: "Explained", lines: [{ depth: 0, text: "Reads f:" }, { depth: 1, text: "Prints lines matching `x`." }] }]]);
  expect(details("sed 's/x/y/e' f")).toMatchObject([["sed", { _tag: "Explained" }]]);
});

/** Each unit of `command`, judged in /home/dan/project, as `program` and what it does outside that folder: `changes …`, `reads …`, and its `writes` inside. */
const touched = (command: string): ReadonlyArray<string> => {
  const split = unitsOf(ShellCommand.make(command), segmentsOf, { working: WordText.make("/home/dan/project"), home: WordText.make("/home/dan") });
  if (split._tag === "Unparsed") return [`unparsed: ${split.reason}`];
  return split.units.map((unit) =>
    [
      unit.words[0]?.literal ?? "(no program)",
      ...unit.changesOutside.map((change) => `${change.verb} ${change.path ?? "(its input)"}`),
      ...(unit.outside.length === 0 ? [] : [`reads ${unit.outside.join(", ")}`]),
      ...(unit.writes.length === 0 ? [] : [`writes inside ${unit.writes.join(", ")}`]),
    ].join(" "),
  );
};

test("rm, mv, chmod and the programs like them change each operand; only operands outside the working folder count, and inside it they are not writes", () => {
  expect(touched("rm -rf build /home/dan/project/tmp")).toEqual(["rm"]);
  expect(touched("rm -rf ~/Code/other ../sibling")).toEqual(["rm deletes ~/Code/other deletes ../sibling"]);
  expect(touched('rm -rf "$DIR"')).toEqual(['rm deletes "$DIR"']);
  expect(touched("mv notes.txt ~/notes.txt")).toEqual(["mv moves ~/notes.txt"]);
  expect(touched("mv -t /tmp a b")).toEqual(["mv moves /tmp"]);
  expect(touched("chmod +x ~/bin/tool && chmod 755 run.sh")).toEqual(["chmod changes ~/bin/tool", "chmod"]);
  expect(touched("chmod -x ~/bin/tool && chmod -R u=rw,go-rwx ~/secrets && chmod --reference=a ~/b")).toEqual(["chmod changes ~/bin/tool", "chmod changes ~/secrets", "chmod changes ~/b"]);
  expect(touched("chown dan:staff /etc/hosts")).toEqual(["chown changes /etc/hosts"]);
  expect(touched("touch /tmp/marker && mkdir -p /tmp/out build")).toEqual(["touch writes /tmp/marker", "mkdir writes /tmp/out"]);
});

test("cp, install and rsync write their last operand or -t's folder and read the others; ln writes the link it makes; curl and wget write the files their options name", () => {
  expect(touched("cp ~/.ssh/id_rsa .")).toEqual(["cp reads ~/.ssh/id_rsa"]);
  expect(touched("cp -r src /tmp/backup")).toEqual(["cp writes /tmp/backup"]);
  expect(touched("cp -t /tmp a b")).toEqual(["cp writes /tmp"]);
  expect(touched("rsync -av --exclude node_modules src/ ~/backup/")).toEqual(["rsync writes ~/backup/"]);
  expect(touched("ln -s /etc/hosts hosts && ln -s tool ~/bin/tool")).toEqual(["ln", "ln writes ~/bin/tool"]);
  expect(touched("curl -o ~/bin/x https://example.com/x && curl https://example.com/a/b")).toEqual(["curl writes ~/bin/x", "curl"]);
  expect(touched("wget -O /tmp/page.html https://example.com")).toEqual(["wget writes /tmp/page.html"]);
  expect(touched("curl -s -o /dev/null -w '%{http_code}' https://example.com && cp /dev/null empty.txt")).toEqual(["curl", "cp"]);
});

test("a redirect, tee or sed -i that writes outside the working folder changes a file there; a redirect's input outside it is read", () => {
  expect(touched("echo x >> ~/.zshrc && echo y > notes.txt")).toEqual(["echo", "(no program) writes ~/.zshrc", "echo", "(no program) writes inside notes.txt"]);
  expect(touched("echo hi > /dev/null 2>&1")).toEqual(["echo"]);
  expect(touched("cat < ~/.aws/credentials")).toEqual(["cat", "(no program) reads ~/.aws/credentials"]);
  expect(touched("git log | tee /tmp/log.txt")).toEqual(["git", "tee writes /tmp/log.txt"]);
  expect(touched("sed -i 's/a/b/' ~/.bashrc")).toEqual(["sed writes ~/.bashrc reads ~/.bashrc"]);
});

test("find reads its starting points, and with -delete deletes what it finds under them; xargs gives a program operands from its input, which count as changes outside", () => {
  expect(touched("find ~/Code/other -name '*.log'")).toEqual(["find reads ~/Code/other"]);
  expect(touched("find /tmp/x -name '*.log' -delete")).toEqual(["find deletes /tmp/x"]);
  expect(touched("find . -name '*.pyc' -delete")).toEqual(["find writes inside the files that find finds"]);
  expect(touched("find -L src -type f")).toEqual(["find"]);
  expect(touched("pushd /tmp && rm -rf build")).toEqual(["pushd reads /tmp", "rm"]);
  expect(touched("git ls-files -z | xargs -0 rm")).toEqual(["git", "rm deletes (its input)"]);
  expect(touched("ls | xargs -I{} cp {} /tmp/out")).toEqual(["ls", "cp writes /tmp/out"]);
  expect(touched("git ls-files | xargs cat")).toEqual(["git", "cat"]);
});

test("the text that cat, echo or tee writes to one file is the redirect's or tee's detail: whether it is added to the end, and whether the shell expands it", () => {
  const writes = (path: string, text: string, append = false, expands = false) => ({ _tag: "Writes", path, text, append, expands });
  expect(details("cat > config.yml <<'EOF'\nname: x\nEOF")).toEqual([[undefined, writes("config.yml", "name: x\n")]]);
  expect(details("cat <<EOF >> notes.md\n$HOME\nEOF")).toEqual([[undefined, writes("notes.md", "$HOME\n", true, true)]]);
  expect(details("cat <<< 'one line' > a.txt")).toEqual([[undefined, writes("a.txt", "one line\n")]]);
  expect(details("echo hello world > a.txt && echo x >> a.txt")).toEqual([
    [undefined, writes("a.txt", "hello world\n")],
    [undefined, writes("a.txt", "x\n", true)],
  ]);
  expect(details("tee -a log.txt <<< 'x'")).toEqual([["tee", writes("log.txt", "x\n", true)]]);
});

test("a write whose text or file its words do not show has no detail: printf, echo with a backslash or an option, cat of a file, two files, a file not written out", () => {
  for (const command of ["printf 'x\\n' > a.txt", "echo 'a\\tb' > a.txt", "echo -e x > a.txt", "echo -n x > a.txt", "cat other.txt > a.txt", "cat > a.txt > b.txt <<< x", 'cat > "$OUT" <<< x', "tee a.txt b.txt <<< x"]) {
    expect([command, details(command)]).toEqual([command, []]);
  }
});
