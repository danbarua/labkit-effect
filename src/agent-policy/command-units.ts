/**
 * The programs a shell command runs, as the permission policy judges them (`permissions.ts`): its
 * segments (`command-segments.ts`), each read past the programs that only run another program.
 *
 * A segment's simple command becomes one or more units:
 *
 * - **Wrappers** run the program after their options, so the unit is that program: `env`,
 *   `timeout`, `nice`, `nohup`, `time`, `command`, `stdbuf`, `exec`, `xargs`, and the project
 *   runners `uv run`, `poetry run`, `pnpm exec`, `bundle exec`, `pipenv run`, `pdm run`,
 *   `hatch run`, `rye run`. An option that a wrapper is not known to take makes the unit opaque.
 * - **Shells and `eval`** with code written out as literal words (`bash -c 'make test'`,
 *   `eval 'git log'`) are judged by that code's own units, to `maxDepth` levels. Code that is not
 *   written out, or that a shell reads from its input (`curl … | sh`, a here-document), is opaque.
 * - **`git`**'s global options are dropped (`git -C dir log` is `git log`), except `-c`,
 *   `--config-env` and `--exec-path`, which can make git run other programs: those are opaque.
 * - **`find`** is a unit, and each `-exec`, `-execdir`, `-ok` or `-okdir` command is a unit of its
 *   own. `-delete` and the `-fprint` options write files.
 * - **Runtimes** (`python3`, `node`, `ruby`, `perl`, `php`, `lua`, `osascript`, `Rscript`, `pwsh`,
 *   and `bun -e`, `deno eval`) are opaque with code written in the command (`-c`, `-e`) or read from
 *   their input. `awk` and `sed` run a program written in the command, so they are opaque too
 *   (unless it is in a file, `-f`), as are `rg --pre`, `watch`, `parallel`, `script` and `expect`.
 * - **Another user**: `sudo`, `doas`, `su` and `pkexec` are opaque.
 * - **Commands that git or ssh run**: `git rebase --exec`, `git submodule foreach`, `git bisect run`,
 *   `git difftool --extcmd`, `git filter-branch`, and `ssh <host> <command>` are opaque; `trap`'s code
 *   is judged as `eval`'s is.
 * - **A call to a function** defined in the same command is not a unit: the function's body is
 *   judged where it is defined, and a function does not outlive its command.
 *
 * A unit's grant is what "allow for the rest of the session" names (`grantOf`): the program; for a
 * program whose second word is a subcommand, that subcommand too (`git log`, `cargo test`;
 * `gh pr view` and `docker compose up` take two words); for a package script or package runner, the
 * script or package (`bun run build`, `npx eslint`); for a runtime or shell, its module or script
 * (`python3 -m pytest`, `bash build.sh`). There is no grant, so only the one call can be allowed, when
 * the subcommand, script or package is not a literal word or comes after an option.
 *
 * A unit also lists the files written by its redirects (`>`, `>>`, `>|`, `&>`, `&>>`, `<>`, and
 * `>&` to a name), and by `tee`, `dd of=`, `sort -o`, `git --output` and `find -delete`.
 * `/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, `/dev/tty` and file descriptors are not files; a target
 * that is not a literal word is a file all the same.
 *
 * Paths are judged against the working folder (`Folders`). A file written outside it is not one of
 * the unit's writes but one of its changes outside, as are the paths outside it that a program in
 * `changers` deletes, moves, writes or changes (`rm`, `mv`, `cp`'s destination, `chmod`, `touch`,
 * `curl -o`). Inside the working folder, those programs' operands are not writes: `rm build` needs
 * only `rm` to be allowed. Paths that `xargs` gives such a program on its input are not written out,
 * so they count as changes outside. A unit lists the paths outside the working folder that it reads:
 * the read-only programs' operands, `cp`'s sources, `find`'s starting points, `sed`'s files, `git -C`,
 * and a redirect's input (`<`). Symbolic links are not followed.
 *
 * Setting a variable that chooses which programs or code run (`PATH`, `LD_*`, `DYLD_*`, `GIT_*`,
 * `BASH_ENV`, `NODE_OPTIONS`, …) for a command, with `env`, or with `export`, makes its unit opaque.
 *
 * The tables follow exo-project's corpus of coding agents' commands (spikes 01_2 and 01_3).
 */

import { Schema } from "effect";
import { type Segment, type SegmentsOf, ShellCommand, type UnparsedReason, type Word, WordText } from "./command-segments.ts";
import { leavesFolder, resolvePath } from "./path-resolver.ts";
import { effectsOf, explain as explainSed, ExplanationLine, parse as parseSed, SedFile, SedScript } from "./sed-script.ts";

/** Why a unit's words do not show what it runs. */
export const NeedText = Schema.String.pipe(Schema.brand("agent-policy/NeedText"));
export type NeedText = typeof NeedText.Type;

/** The language of code that a command gives a program to run, for showing it. */
export const CodeLanguage = Schema.Literals(["python", "javascript", "typescript", "ruby", "perl", "php", "lua", "applescript", "r", "powershell", "awk", "bash"]);
export type CodeLanguage = typeof CodeLanguage.Type;

/** Code that a command gives a program to run, as written. */
export const CodeText = Schema.String.pipe(Schema.brand("agent-policy/CodeText"));
export type CodeText = typeof CodeText.Type;

/**
 * Text that a command writes to a file, when its words show it: the file's path as written, the
 * text, whether it is added to the end of the file (`>>`, `tee -a`), and whether the shell expands
 * `$…` and `` `…` `` in it first, so that what is written may differ.
 */
export const Writes = Schema.TaggedStruct("Writes", { path: WordText, text: CodeText, append: Schema.Boolean, expands: Schema.Boolean });
export type Writes = typeof Writes.Type;

/**
 * What helps a person judge a program: what it does, in plain English (`sed`), the code it runs, in
 * its language, or the text it writes to a file.
 */
export const Detail = Schema.Union([Schema.TaggedStruct("Explained", { lines: Schema.Array(ExplanationLine) }), Schema.TaggedStruct("Code", { language: CodeLanguage, code: CodeText }), Writes]);
export type Detail = typeof Detail.Type;

/** What a program does to a path outside the working folder: writes a file there, deletes it, moves it, or changes its permissions or owner. */
export type ChangeVerb = "writes" | "deletes" | "moves" | "changes";

/** A path outside the working folder that a program changes, as written, and how; `path` is undefined for the paths a program is given on its input (`xargs rm`). */
export interface OutsideChange {
  readonly verb: ChangeVerb;
  readonly path: WordText | undefined;
}

/** A program that a command runs, after the programs around it that only run it. */
export interface Unit {
  /** Its words from the program on, as the command writes them. Empty for a segment that runs no program but writes a file. */
  readonly words: ReadonlyArray<Word>;
  /** What "allow for the rest of the session" names; undefined when only the one call can be allowed. */
  readonly grant: ReadonlyArray<WordText> | undefined;
  /** The files it writes inside the working folder, as written. */
  readonly writes: ReadonlyArray<WordText>;
  /** The paths outside the working folder that it writes, deletes, moves or changes: absolute, through `..` or `~`, not written out, or given on its input. */
  readonly changesOutside: ReadonlyArray<OutsideChange>;
  /** Why its words do not show what it runs; undefined when they do. */
  readonly opaque: NeedText | undefined;
  /** The paths it reads outside the working folder, as written: absolute, through `..` or `~`, or not written out. */
  readonly outside: ReadonlyArray<WordText>;
  /** Every path it reads or changes, inside the working folder or outside it, with how: what path rules (`Read(...)`, `Edit(...)`) are matched against. */
  readonly paths: ReadonlyArray<UnitPath>;
  /** What it does in plain English, or the code it runs; for showing to the person asked. */
  readonly detail: Detail | undefined;
}

/** A path a unit reads or changes, as written, and how; `word` is undefined for the paths a program is given on its input (`xargs rm`). */
export interface UnitPath {
  readonly access: "reads" | ChangeVerb;
  readonly word: Word | undefined;
}

export type Units = { readonly _tag: "Units"; readonly units: ReadonlyArray<Unit> } | { readonly _tag: "Unparsed"; readonly reason: UnparsedReason };

/** The folders that paths are judged against: the working folder, and the home folder that `~` names; both absolute. */
export interface Folders {
  readonly working: WordText;
  readonly home: WordText;
}

/** How many levels of written-out shell code (`bash -c '…'` inside `bash -c '…'`) are followed. */
export const maxDepth = 3;

type Name = Parameters<typeof WordText.make>[0];
const named = (...names: ReadonlyArray<Name>): ReadonlySet<WordText> => new Set(names.map((name) => WordText.make(name)));
const need = (text: Parameters<typeof NeedText.make>[0]): NeedText => NeedText.make(text);
const literalOf = (word: Word | undefined): WordText | undefined => word?.literal;
const basename = (name: WordText): WordText => WordText.make(name.slice(name.lastIndexOf("/") + 1));
const isOption = (word: Word | undefined): boolean => (word?.literal ?? word?.text ?? "").startsWith("-");
const is = (word: Word | undefined, ...values: ReadonlyArray<Name>): boolean => word?.literal !== undefined && values.includes(word.literal);
const present = <A>(value: A | undefined): ReadonlyArray<A> => (value === undefined ? [] : [value]);

const textOf = (word: Word): WordText => word.literal ?? word.text;
const literalWord = (text: Name): Word => ({ text: WordText.make(text), literal: WordText.make(text) });

/** What a unit does to files, before its paths are judged against the working folder (`folders`). */
interface Touches {
  readonly folders?: Folders | undefined;
  /** The files it writes: those inside the working folder are its writes, the others its changes outside. */
  readonly writes?: ReadonlyArray<Word>;
  /** The paths it deletes, moves, writes or changes as a program in `changers`: only those outside the working folder count. */
  readonly changes?: ReadonlyArray<{ readonly verb: ChangeVerb; readonly word: Word }>;
  /** What it does to the paths it is given on its input (`xargs rm`), when it changes them. */
  readonly fed?: ChangeVerb | undefined;
  /** The paths it reads: those outside the working folder are its reads outside. */
  readonly reads?: ReadonlyArray<Word>;
  readonly detail?: Detail;
}

const unit = (words: ReadonlyArray<Word>, grant: ReadonlyArray<WordText> | undefined, touches: Touches = {}): Unit => {
  const written = touches.writes ?? [];
  const outside = (word: Word): boolean => escapes(word, touches.folders);
  const reads = touches.reads ?? [];
  return {
    words,
    grant,
    writes: written.filter((word) => !outside(word)).map(textOf),
    changesOutside: [
      ...written.filter(outside).map((word): OutsideChange => ({ verb: "writes", path: textOf(word) })),
      ...(touches.changes ?? []).filter((change) => outside(change.word)).map((change): OutsideChange => ({ verb: change.verb, path: textOf(change.word) })),
      ...(touches.fed === undefined ? [] : [{ verb: touches.fed, path: undefined }]),
    ],
    opaque: undefined,
    outside: reads.filter(outside).map(textOf),
    paths: [
      ...reads.map((word): UnitPath => ({ access: "reads", word })),
      ...written.map((word): UnitPath => ({ access: "writes", word })),
      ...(touches.changes ?? []).map((change): UnitPath => ({ access: change.verb, word: change.word })),
      ...(touches.fed === undefined ? [] : [{ access: touches.fed, word: undefined }]),
    ],
    detail: touches.detail,
  };
};
const opaque = (words: ReadonlyArray<Word>, why: NeedText, detail?: Detail): Unit => ({ words, grant: undefined, writes: [], changesOutside: [], opaque: why, outside: [], paths: [], detail });

/** The code `code` in `language`, as a detail, without the line break that ends a here-document; undefined when there is no code to show. */
const codeOf = (language: CodeLanguage, code: WordText | undefined): Detail | undefined => {
  const trimmed = code?.replace(/\n$/, "");
  return trimmed === undefined || trimmed === "" ? undefined : { _tag: "Code", language, code: CodeText.make(trimmed) };
};

// —— Variables ——

const steering = named("PATH", "ENV", "BASH_ENV", "IFS", "PROMPT_COMMAND", "SHELLOPTS", "BASHOPTS", "PS4", "PAGER", "EDITOR", "VISUAL", "BROWSER", "LESSOPEN");
const steeringOthers = named("NODE_OPTIONS", "PYTHONPATH", "PYTHONSTARTUP", "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB");
const steeringPrefixes: ReadonlyArray<Name> = ["LD_", "DYLD_", "GIT_"];

/** Whether an assignment (`NAME=value`, `NAME+=value`) sets a variable that chooses which programs or code run. */
const steers = (assignment: WordText): boolean => {
  const name = WordText.make((assignment.split("=")[0] ?? "").replace(/\+$/, ""));
  return steering.has(name) || steeringOthers.has(name) || steeringPrefixes.some((prefix) => name.startsWith(prefix));
};

const steeringNeed = (assignments: ReadonlyArray<WordText>): NeedText | undefined => {
  const found = assignments.find(steers);
  return found === undefined ? undefined : need(`it sets ${found.split("=")[0] ?? found}, which chooses the programs or code that run`);
};

const isAssignment = (word: Word): boolean => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word.literal ?? word.text);

// —— Grants ——

const twoWordSubcommands = named("gh", "docker", "kubectl");
const subcommands = named(
  "git", "cargo", "npm", "npx", "pnpm", "yarn", "bun", "uv", "terraform", "aws", "gcloud", "az", "helm", "poetry", "pip", "pip3", "pipx", "go", "rustup",
  "brew", "apt", "apt-get", "nix", "make", "cmake", "systemctl", "journalctl", "ssh", "deno",
);
const packageRunners = named("npx", "bunx", "uvx");
/** The subcommands that run a script or package, which the grant then names too. */
const namingSubcommands: ReadonlyMap<WordText, ReadonlySet<WordText>> = new Map([
  [WordText.make("npm"), named("run", "run-script", "exec", "x")],
  [WordText.make("pnpm"), named("run", "dlx", "exec")],
  [WordText.make("yarn"), named("run", "dlx", "exec")],
  [WordText.make("bun"), named("run", "x")],
  [WordText.make("pipx"), named("run")],
  [WordText.make("deno"), named("run", "task")],
]);

const isSubcommandWord = (word: Word | undefined): word is Word & { readonly literal: WordText } =>
  word?.literal !== undefined && /^[A-Za-z]/.test(word.literal);
const isPackageWord = (word: Word | undefined): word is Word & { readonly literal: WordText } =>
  word?.literal !== undefined && /^[@A-Za-z]/.test(word.literal);

/** Returns the grant for a unit whose words are `words` (see the module's comment). */
export const grantOf = (words: ReadonlyArray<Word>): ReadonlyArray<WordText> | undefined => {
  const [first, second, third] = words;
  const program = literalOf(first);
  if (program === undefined) return undefined;
  const base = basename(program);
  if (packageRunners.has(base)) return isPackageWord(second) ? [program, second.literal] : undefined;
  // A project runner read past runs the program after it; one that could not be (an option first) has no grant.
  if (second?.literal !== undefined && projectRunners.get(base) === second.literal) return undefined;
  if (!subcommands.has(base) && !twoWordSubcommands.has(base)) return [program];
  if (!isSubcommandWord(second)) return undefined;
  if (namingSubcommands.get(base)?.has(second.literal) === true) return isPackageWord(third) ? [program, second.literal, third.literal] : undefined;
  if (twoWordSubcommands.has(base) && isSubcommandWord(third)) return [program, second.literal, third.literal];
  return [program, second.literal];
};

// —— Wrappers ——

/** A wrapper's options: those that take the next word as their value, and those that take none. */
interface WrapperOptions {
  readonly valued: ReadonlySet<WordText>;
  readonly flags: ReadonlySet<WordText>;
  /** Whether a value may be attached to its option (`-n5`, `--signal=KILL`). */
  readonly attached: boolean;
  /** How many words it takes after its options, before the program (`timeout`'s duration). */
  readonly operands: number;
}

const wrapper = (valued: ReadonlyArray<Name>, flags: ReadonlyArray<Name>, attached: boolean, operands = 0): WrapperOptions => ({ valued: named(...valued), flags: named(...flags), attached, operands });

const wrappers: ReadonlyMap<WordText, WrapperOptions> = new Map([
  [WordText.make("env"), wrapper(["-u", "--unset", "-C", "--chdir"], ["-i", "-", "--ignore-environment", "-0", "--null", "-v", "--debug"], true)],
  [WordText.make("timeout"), wrapper(["-s", "--signal", "-k", "--kill-after"], ["--preserve-status", "--foreground", "-v", "--verbose", "-f"], true, 1)],
  [WordText.make("nice"), wrapper(["-n", "--adjustment"], [], true)],
  [WordText.make("nohup"), wrapper([], [], false)],
  [WordText.make("time"), wrapper([], ["-p", "-l", "-a"], false)],
  [WordText.make("command"), wrapper([], ["-p"], false)],
  [WordText.make("stdbuf"), wrapper(["-i", "-o", "-e", "--input", "--output", "--error"], [], true)],
  [WordText.make("exec"), wrapper(["-a"], ["-c", "-l", "-cl", "-lc"], false)],
  [
    WordText.make("xargs"),
    wrapper(
      ["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof", "--replace", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"],
      ["-0", "-r", "-t", "-p", "-x", "-o", "--null", "--no-run-if-empty", "--verbose", "--interactive", "--exit", "--open-tty"],
      true,
    ),
  ],
]);

/** Whether `option` is one of `options.valued` with its value attached. */
const attachedValue = (options: WrapperOptions, option: WordText): boolean =>
  options.attached && ([...options.valued].some((valued) => option !== valued && option.startsWith(valued.startsWith("--") ? `${valued}=` : valued)) || /^-\d+$/.test(option));

/** Returns the words after a wrapper's options and operands (the program and its arguments), or undefined when an option is not known or a word it needs is not literal. */
const pastOptions = (options: WrapperOptions, rest: ReadonlyArray<Word>): ReadonlyArray<Word> | undefined => {
  const [next, ...after] = rest;
  if (next === undefined) return [];
  const option = next.literal;
  if (option === WordText.make("--")) return after.slice(options.operands);
  if (option !== undefined && options.flags.has(option)) return pastOptions(options, after);
  if (option !== undefined && options.valued.has(option)) return after.length === 0 ? undefined : pastOptions(options, after.slice(1));
  if (option !== undefined && option.startsWith("-") && attachedValue(options, option)) return pastOptions(options, after);
  if (isOption(next)) return undefined;
  if (options.operands === 0) return rest;
  return option === undefined ? undefined : rest.slice(options.operands);
};

/** The project runners: `<program> <subcommand>` runs the program after it. */
const projectRunners: ReadonlyMap<WordText, WordText> = new Map(
  (
    [
      ["uv", "run"],
      ["poetry", "run"],
      ["pnpm", "exec"],
      ["bundle", "exec"],
      ["pipenv", "run"],
      ["pdm", "run"],
      ["hatch", "run"],
      ["rye", "run"],
    ] as const
  ).map(([program, subcommand]) => [WordText.make(program), WordText.make(subcommand)]),
);

// —— Programs that run code ——

const shells = named("sh", "bash", "zsh", "dash", "ksh", "mksh", "fish");
const shellValued = named("-o", "+o", "-O", "+O", "--rcfile", "--init-file");
const asAnotherUser = named("sudo", "doas", "su", "pkexec");
const notFollowed = named("watch", "parallel", "script", "expect");
const inlineProgram = named("awk", "gawk", "mawk", "nawk");
const seds = named("sed", "gsed");
const declaring = named("export", "declare", "typeset", "local", "readonly");

/** A runtime: the options with which it runs code written in the command, and the language of that code. */
interface Runtime {
  readonly inline: ReadonlySet<WordText>;
  readonly language: CodeLanguage;
}

const runtimes: ReadonlyMap<WordText, Runtime> = new Map([
  [WordText.make("python"), { inline: named("-c"), language: "python" }],
  [WordText.make("python3"), { inline: named("-c"), language: "python" }],
  [WordText.make("node"), { inline: named("-e", "--eval", "-p", "--print"), language: "javascript" }],
  [WordText.make("ruby"), { inline: named("-e"), language: "ruby" }],
  [WordText.make("perl"), { inline: named("-e", "-E"), language: "perl" }],
  [WordText.make("php"), { inline: named("-r"), language: "php" }],
  [WordText.make("lua"), { inline: named("-e"), language: "lua" }],
  [WordText.make("osascript"), { inline: named("-e"), language: "applescript" }],
  [WordText.make("Rscript"), { inline: named("-e"), language: "r" }],
  [WordText.make("pwsh"), { inline: named("-c", "-Command", "-command"), language: "powershell" }],
  [WordText.make("powershell"), { inline: named("-c", "-Command", "-command"), language: "powershell" }],
]);

/** Returns the runtime that `base` names: `python3.12` is `python3`. */
const runtimeOf = (base: WordText): Runtime | undefined => runtimes.get(WordText.make(base.replace(/^python3\.\d+$/, "python3")));

const awkValued = named("-F", "-v", "-f", "--file", "--field-separator", "--assign");

/** The program that `awk`'s arguments `rest` write out: the first operand past its options; undefined when it is not a literal word. */
const awkProgram = (rest: ReadonlyArray<Word>): WordText | undefined => {
  const [next, ...after] = rest;
  if (next === undefined) return undefined;
  if (is(next, "--")) return literalOf(after[0]);
  if (next.literal !== undefined && awkValued.has(next.literal)) return awkProgram(after.slice(1));
  return isOption(next) ? awkProgram(after) : next.literal;
};

/** The code that `deno eval`'s arguments `rest` write out: the first operand past its options. */
const denoCode = (rest: ReadonlyArray<Word>): WordText | undefined => literalOf(rest.find((word) => !isOption(word)));

// —— Files written ——

const notFiles = named("/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty");

/** Returns `target` when it names a file; undefined when it names none (`/dev/null`, a file descriptor). */
const fileOf = (target: Word | undefined): Word | undefined => {
  const value = target?.literal;
  return value !== undefined && (notFiles.has(value) || value.startsWith("/dev/fd/")) ? undefined : target;
};

/** The files that `segment`'s redirects write. */
const redirectWrites = (segment: Segment): ReadonlyArray<Word> =>
  segment.redirects.flatMap((redirect) => {
    if (redirect.op === ">&") {
      const value = redirect.target?.literal;
      return value !== undefined && /^(\d+-?|-)$/.test(value) ? [] : present(fileOf(redirect.target));
    }
    return [">", ">>", ">|", "&>", "&>>", "<>"].includes(redirect.op) ? present(fileOf(redirect.target)) : [];
  });

/** The files a program writes through its own options and arguments: `tee`, `dd of=`, `sort -o`, `git --output`. */
const ownWrites = (base: WordText, words: ReadonlyArray<Word>): ReadonlyArray<Word> => {
  const args = words.slice(1);
  if (base === WordText.make("tee")) return args.filter((word) => !isOption(word));
  if (base === WordText.make("dd")) return args.flatMap((word) => (word.literal?.startsWith("of=") === true ? [literalWord(word.literal.slice(3))] : []));
  const valued = (short: Name | undefined, long: Name): ReadonlyArray<Word> =>
    args.flatMap((word, at) => {
      const value = word.literal;
      if (value === undefined) return [];
      if (value === short || value === long) return present(args[at + 1]);
      return value.startsWith(`${long}=`) ? [literalWord(value.slice(long.length + 1))] : [];
    });
  if (base === WordText.make("sort")) return valued("-o", "--output");
  if (base === WordText.make("git")) return valued(undefined, "--output");
  return [];
};

// —— Paths changed ——

/**
 * A program that changes the paths it is given: what it does to them, its options that take a value,
 * its leading operands that are not paths (`chmod`'s mode, `chown`'s owner), which operands it
 * changes, and its options whose value is a path it changes (`-t DIR`, `curl -o FILE`).
 *
 * `every`: each operand is changed. `last`: given two operands or more and no output option, the last
 * one is changed; the others, and every operand when an output option names the destination, are
 * read (`cp`) or not used (`ln`'s targets). `none`: its operands are not paths (`curl`'s URLs).
 */
interface Changer {
  readonly verb: ChangeVerb;
  readonly valued: ReadonlySet<WordText>;
  readonly skip: number;
  /** Whether its first operand is a mode, which may start with `-` (`chmod -x`). */
  readonly mode: boolean;
  readonly operands: "every" | "last" | "none";
  readonly othersRead: boolean;
  readonly outputs: ReadonlySet<WordText>;
}

const changer = (verb: ChangeVerb, operands: Changer["operands"], options: Partial<Omit<Changer, "verb" | "operands">> = {}): Changer => ({
  verb,
  operands,
  valued: options.valued ?? named(),
  skip: options.skip ?? 0,
  mode: options.mode ?? false,
  othersRead: options.othersRead ?? false,
  outputs: options.outputs ?? named(),
});
const targetDirectory = named("-t", "--target-directory");

/** A `chmod` mode: octal (`755`), or symbolic (`+x`, `-w`, `u=rw,go-rwx`). */
const chmodMode = /^([0-7]{1,4}|[ugoa]*[-+=][rwxXstugo]*([-+=][rwxXstugo]*)*(,[ugoa]*[-+=][rwxXstugo]*([-+=][rwxXstugo]*)*)*)$/;

const changers: ReadonlyMap<WordText, Changer> = new Map([
  [WordText.make("rm"), changer("deletes", "every")],
  [WordText.make("rmdir"), changer("deletes", "every")],
  [WordText.make("unlink"), changer("deletes", "every")],
  [WordText.make("shred"), changer("deletes", "every", { valued: named("-n", "--iterations", "-s", "--size", "--random-source") })],
  [WordText.make("mv"), changer("moves", "every", { valued: named("-S", "--suffix"), outputs: targetDirectory })],
  [WordText.make("cp"), changer("writes", "last", { valued: named("-S", "--suffix"), othersRead: true, outputs: targetDirectory })],
  [WordText.make("install"), changer("writes", "last", { valued: named("-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix"), othersRead: true, outputs: targetDirectory })],
  // ln's targets count as read: a link to a file outside the folder lets it be read from inside.
  [WordText.make("ln"), changer("writes", "last", { valued: named("-S", "--suffix"), othersRead: true, outputs: targetDirectory })],
  [
    WordText.make("rsync"),
    changer("writes", "last", {
      valued: named("-e", "--rsh", "--rsync-path", "-f", "--filter", "--exclude", "--include", "--exclude-from", "--include-from", "--files-from", "-T", "--temp-dir", "--partial-dir", "--backup-dir", "--log-file", "--password-file", "--compare-dest", "--copy-dest", "--link-dest", "--chmod", "--chown", "--max-size", "--min-size", "--bwlimit", "--timeout", "--port", "--suffix", "-M", "--remote-option"),
      othersRead: true,
    }),
  ],
  [WordText.make("touch"), changer("writes", "every", { valued: named("-r", "--reference", "-d", "--date", "-t") })],
  [WordText.make("mkdir"), changer("writes", "every", { valued: named("-m", "--mode") })],
  [WordText.make("truncate"), changer("writes", "every", { valued: named("-s", "--size", "-r", "--reference") })],
  [WordText.make("chmod"), changer("changes", "every", { mode: true })],
  [WordText.make("chown"), changer("changes", "every", { skip: 1 })],
  [WordText.make("chgrp"), changer("changes", "every", { skip: 1 })],
  [WordText.make("curl"), changer("writes", "none", { outputs: named("-o", "--output", "--output-dir") })],
  [WordText.make("wget"), changer("writes", "none", { outputs: named("-O", "--output-document", "-P", "--directory-prefix", "-o", "--output-file", "-a", "--append-output") })],
]);

/** What a program in `changers` changes and reads, from its words; `fed` when `xargs` gives it more operands on its input. Undefined for any other program. */
const changesOf = (base: WordText, words: ReadonlyArray<Word>, fed: boolean): Pick<Touches, "changes" | "fed"> & { readonly reads: ReadonlyArray<Word> } | undefined => {
  const known = changers.get(base);
  if (known === undefined) return undefined;
  const scan = (rest: ReadonlyArray<Word>, operands: ReadonlyArray<Word>, outputs: ReadonlyArray<Word>, ended: boolean): { readonly operands: ReadonlyArray<Word>; readonly outputs: ReadonlyArray<Word> } => {
    const [next, ...after] = rest;
    if (next === undefined) return { operands, outputs };
    const option = next.literal;
    if (ended || !isOption(next)) return scan(after, [...operands, next], outputs, ended);
    if (option === WordText.make("--")) return scan(after, operands, outputs, true);
    if (option !== undefined && known.outputs.has(option)) return scan(after.slice(1), operands, [...outputs, ...present(after[0])], false);
    if (option !== undefined && known.valued.has(option)) return scan(after.slice(1), operands, outputs, false);
    const attached = option === undefined ? null : /^(--[^=]+)=(.*)$/.exec(option);
    if (attached?.[1] !== undefined && known.outputs.has(WordText.make(attached[1]))) return scan(after, operands, [...outputs, literalWord(attached[2] ?? "")], false);
    return scan(after, operands, outputs, false);
  };
  const byReference = words.some((word) => word.literal?.startsWith("--reference") === true);
  const modeAt = known.mode && !byReference ? words.findIndex((word, at) => at > 0 && chmodMode.test(word.literal ?? "")) : -1;
  const { operands, outputs } = scan(words.slice(1).filter((_, at) => at + 1 !== modeAt), [], [], false);
  const paths = operands.slice(byReference ? 0 : known.skip);
  const destination = known.operands === "last" && outputs.length === 0 && paths.length >= 2 ? paths.slice(-1) : [];
  const changed = known.operands === "every" ? paths : destination;
  const others = known.operands === "last" ? paths.slice(0, paths.length - destination.length) : [];
  const files = (words: ReadonlyArray<Word>): ReadonlyArray<Word> => words.flatMap((word) => present(fileOf(word)));
  return {
    changes: files([...changed, ...outputs]).map((word) => ({ verb: known.verb, word })),
    fed: fed && known.operands === "every" ? known.verb : undefined,
    reads: known.othersRead ? files(others) : [],
  };
};

// —— Paths outside the working folder ——

/** `path`, as written, resolved against `folders` (`path-resolver.ts`); undefined when it is not resolved, as for another user's `~`. */
export const fullPathOf = (path: WordText, folders: Folders): WordText | undefined => {
  const resolved = resolvePath(literalWord(path), folders);
  return resolved._tag === "Local" ? resolved.full : undefined;
};

/** Whether `word`, a path, may be outside the working folder (`leavesFolder`, `path-resolver.ts`). */
const escapes = leavesFolder;

/** For each read-only program whose arguments are paths, its options that take the next word as a value. */
const pathPrograms: ReadonlyMap<WordText, ReadonlySet<WordText>> = new Map([
  [WordText.make("ls"), named("-I", "--ignore", "--hide", "-w", "--width", "-T", "--tabsize", "--format", "--sort", "--time", "--time-style", "--color", "--block-size")],
  [WordText.make("cat"), named()],
  [WordText.make("head"), named("-n", "-c", "--lines", "--bytes")],
  [WordText.make("tail"), named("-n", "-c", "--lines", "--bytes", "-s", "--sleep-interval", "--pid")],
  [WordText.make("wc"), named()],
  [WordText.make("cd"), named()],
  [WordText.make("pushd"), named()],
  [
    WordText.make("grep"),
    named("-e", "--regexp", "-f", "--file", "-m", "--max-count", "-A", "--after-context", "-B", "--before-context", "-C", "--context", "--include", "--exclude", "--exclude-dir", "-d", "--directories", "-D", "--devices", "--color", "--colour", "--label", "--binary-files"),
  ],
  [
    WordText.make("rg"),
    named("-e", "--regexp", "-f", "--file", "-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not", "--type-add", "-m", "--max-count", "-A", "--after-context", "-B", "--before-context", "-C", "--context", "-j", "--threads", "--max-depth", "-M", "--max-columns", "--sort", "--sortr", "--color", "-E", "--encoding", "--max-filesize", "-r", "--replace"),
  ],
]);
const patternFiles = named("-f", "--file");
const patterns = named("-e", "--regexp", "-f", "--file");

/** The paths that a read-only program's arguments name: its operands (for grep and rg, not the pattern) and its pattern files. */
const pathsOf = (base: WordText, words: ReadonlyArray<Word>): ReadonlyArray<Word> => {
  const valued = pathPrograms.get(base);
  if (valued === undefined) return [];
  const scan = (rest: ReadonlyArray<Word>, operands: ReadonlyArray<Word>, files: ReadonlyArray<Word>, optionsEnded: boolean): { readonly operands: ReadonlyArray<Word>; readonly files: ReadonlyArray<Word> } => {
    const [next, ...after] = rest;
    if (next === undefined) return { operands, files };
    const option = next.literal;
    if (optionsEnded || !isOption(next)) return scan(after, [...operands, next], files, optionsEnded);
    if (option === WordText.make("--")) return scan(after, operands, files, true);
    if (option !== undefined && valued.has(option)) return scan(after.slice(1), operands, patternFiles.has(option) ? [...files, ...present(after[0])] : files, false);
    const attached = option === undefined ? undefined : /^(--[^=]+)=(.*)$/.exec(option);
    if (attached?.[1] !== undefined && patternFiles.has(WordText.make(attached[1]))) return scan(after, operands, [...files, { text: WordText.make(attached[2] ?? ""), literal: WordText.make(attached[2] ?? "") }], false);
    return scan(after, operands, files, false);
  };
  const { operands, files } = scan(words.slice(1), [], [], false);
  const searching = base === WordText.make("grep") || base === WordText.make("rg");
  const patternGiven = words.slice(1).some((word) => word.literal !== undefined && (patterns.has(word.literal) || /^--(regexp|file)=/.test(word.literal)));
  return [...(searching && !patternGiven ? operands.slice(1) : operands), ...files];
};

/** Whether the policy judges the paths that `program` reads or changes: the read-only programs with paths, `sed`, `find`, and the programs in `changers`. */
export const judgesPathsOf = (program: WordText): boolean => {
  const base = basename(program);
  return pathPrograms.has(base) || changers.has(base) || seds.has(base) || base === WordText.make("find");
};

/** The paths a read-only program reads, as written. `cd` with no folder goes to `~`, and `cd -` to the folder before, which is not written out. */
const readsOf = (base: WordText, words: ReadonlyArray<Word>): ReadonlyArray<Word> => {
  if (base === WordText.make("cd")) {
    if (words.slice(1).some((word) => is(word, "-"))) return [{ text: WordText.make("$OLDPWD") }];
    if (words.slice(1).every(isOption)) return [literalWord("~")];
  }
  return pathsOf(base, words);
};

/** The paths a git command reads: its `-C`, `--git-dir` and `--work-tree`, and the operands of `diff --no-index`. */
const gitReads = (words: ReadonlyArray<Word>, normal: ReadonlyArray<Word>): ReadonlyArray<Word> => {
  const named = words.slice(1).flatMap((word, at, all) => {
    if (is(word, "-C", "--git-dir", "--work-tree")) return present(all[at + 1]);
    const attached = /^--(git-dir|work-tree)=(.*)$/.exec(word.literal ?? "");
    return attached === null ? [] : [literalWord(attached[2] ?? "")];
  });
  const noIndex = normal.some((word) => is(word, "--no-index")) ? normal.slice(2).filter((word) => !isOption(word)) : [];
  return [...named, ...noIndex];
};

// —— sed ——

const sedFlags = named("-n", "--quiet", "--silent", "-E", "-r", "--regexp-extended", "-s", "--separate", "-u", "--unbuffered", "-z", "--null-data", "--posix", "--debug", "--sandbox", "-b", "--binary", "--follow-symlinks");

/**
 * `sed`, judged by its scripts (`sed-script.ts`): opaque when a script runs commands, is in a file
 * (`-f`), is not written out, or is not understood; otherwise a unit whose grant is `sed`, writing
 * the files its scripts name and, with `-i`, the files it edits, and reading its files.
 */
const sedUnits = (words: ReadonlyArray<Word>, folders: Folders | undefined): ReadonlyArray<Unit> => {
  const quiet = words.slice(1).some((word) => is(word, "-n", "--quiet", "--silent") || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(word.literal ?? ""));
  const scan = (rest: ReadonlyArray<Word>, scripts: ReadonlyArray<Word>, operands: ReadonlyArray<Word>, inPlace: boolean): Unit | { readonly scripts: ReadonlyArray<Word>; readonly operands: ReadonlyArray<Word>; readonly inPlace: boolean; readonly quiet: boolean } => {
    const [next, ...after] = rest;
    if (next === undefined) return { scripts, operands, inPlace, quiet };
    const option = next.literal;
    if (!isOption(next)) return scan(after, scripts, [...operands, next], inPlace);
    if (option === undefined) return opaque(words, need("it gives sed an option that is not written out"));
    if (option === WordText.make("--")) return { scripts, operands: [...operands, ...after], inPlace, quiet };
    if (sedFlags.has(option)) return scan(after, scripts, operands, inPlace);
    if (option === WordText.make("-e") || option === WordText.make("--expression")) return after[0] === undefined ? opaque(words, need("sed -e has no script")) : scan(after.slice(1), [...scripts, after[0]], operands, inPlace);
    if (option.startsWith("--expression=")) return scan(after, [...scripts, { text: WordText.make(option.slice(13)), literal: WordText.make(option.slice(13)) }], operands, inPlace);
    if (option === WordText.make("-f") || option === WordText.make("--file") || option.startsWith("--file=")) return opaque(words, need("sed runs a script from a file"));
    if (option === WordText.make("-l") || option === WordText.make("--line-length")) return scan(after.slice(1), scripts, operands, inPlace);
    // BSD sed takes -i's suffix as the next word, often empty (`sed -i '' …`).
    if (option === WordText.make("-i")) return scan(is(after[0], "") ? after.slice(1) : after, scripts, operands, true);
    if (option.startsWith("-i") || option.startsWith("--in-place")) return scan(after, scripts, operands, true);
    return opaque(words, need(`it gives sed an option that is not known (${option})`));
  };
  const read = scan(words.slice(1), [], [], false);
  if ("words" in read) return [read];
  const [inline, ...files] = read.scripts.length === 0 ? read.operands : [undefined, ...read.operands];
  const scripts = read.scripts.length === 0 ? present(inline) : read.scripts;
  if (scripts.length === 0) return [opaque(words, need("sed has no script"))];
  const parsed = scripts.map((script) => (script.literal === undefined ? undefined : parseSed(SedScript.make(script.literal))));
  if (parsed.some((each) => each === undefined)) return [opaque(words, need("sed's script is not written out, or is not understood"))];
  const commands = parsed.filter((each) => each !== undefined);
  const known = commands.map(effectsOf);
  const operands = files.filter((word) => word !== undefined);
  const explained: Detail = {
    _tag: "Explained",
    lines: explainSed(commands, { quiet: read.quiet, inPlace: read.inPlace, files: operands.map((word) => SedFile.make(word.literal ?? word.text)) }),
  };
  if (known.some((each) => each.executes)) return [opaque(words, need("sed's script runs commands (e)"), explained)];
  const named = known.flatMap((each) => each.reads).map((file) => ({ text: WordText.make(file), literal: WordText.make(file) }));
  return [
    unit(words, [WordText.make("sed")], {
      folders,
      writes: [...known.flatMap((each) => each.writes).map(literalWord), ...(read.inPlace ? operands : [])],
      reads: [...operands, ...named],
      detail: explained,
    }),
  ];
};

// —— Units ——

interface Seen {
  readonly segmentsOf: SegmentsOf;
  readonly depth: number;
  /** Whether the program's input is text written in the command (a here-document or here-string). */
  readonly fedText: boolean;
  /** That text, as written, when the command has it. */
  readonly fedBody: WordText | undefined;
  /** Whether `xargs` gives the program more operands, read from its input. */
  readonly fedArgs: boolean;
  readonly folders: Folders | undefined;
}

/** Returns the units of code written out as `code`, one level deeper; opaque when that is too deep or the code does not parse. */
const unitsOfCode = (code: WordText, around: ReadonlyArray<Word>, seen: Seen): ReadonlyArray<Unit> => {
  if (seen.depth >= maxDepth) return [opaque(around, need(`it runs code nested more than ${maxDepth} levels deep`))];
  const inner = unitsAt(ShellCommand.make(code), seen.segmentsOf, seen.depth + 1, seen.folders);
  return inner._tag === "Units" ? inner.units : [opaque(around, need(`the code it runs does not parse: ${inner.reason}`))];
};

const gitHarmless = named("--no-pager", "-P", "-p", "--paginate", "--bare", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks");
const gitHarmlessValued = named("-C", "--git-dir", "--work-tree", "--namespace");
const gitSteering = named("-c", "--config-env", "--exec-path");

/** `git`'s words without its global options, or why it is opaque. */
const gitWords = (words: ReadonlyArray<Word>): ReadonlyArray<Word> | NeedText => {
  const strip = (rest: ReadonlyArray<Word>): ReadonlyArray<Word> | NeedText => {
    const [next, ...after] = rest;
    const option = next?.literal;
    if (next === undefined || !isOption(next)) return rest;
    if (option === undefined) return need("it gives git an option that is not written out");
    const name = WordText.make(option.split("=")[0] ?? option);
    if (gitSteering.has(name)) return need(`git ${name} can make git run other programs`);
    if (gitHarmless.has(option)) return strip(after);
    if (gitHarmlessValued.has(option)) return strip(after.slice(1));
    if (gitHarmlessValued.has(name)) return strip(after);
    return rest;
  };
  const rest = strip(words.slice(1));
  return typeof rest === "string" ? rest : [...words.slice(0, 1), ...rest];
};

/** Why a git command (without its global options) runs another program it names: `rebase --exec`, `submodule foreach`, `bisect run`, `difftool --extcmd`, `filter-branch`; undefined when it does not. */
const gitRunning = (words: ReadonlyArray<Word>): NeedText | undefined => {
  const [, subcommand, ...args] = words;
  const has = (...options: ReadonlyArray<Name>) => args.some((word) => options.some((each) => word.literal === each || word.literal?.startsWith(`${each}=`) === true));
  if (is(subcommand, "rebase") && has("-x", "--exec")) return need("git rebase --exec runs a command for each commit");
  if (is(subcommand, "submodule") && is(args[0], "foreach")) return need("git submodule foreach runs a command in each submodule");
  if (is(subcommand, "bisect") && is(args[0], "run")) return need("git bisect run runs a command for each step");
  if (is(subcommand, "difftool", "mergetool") && has("-x", "--extcmd")) return need("git difftool --extcmd runs the command it names");
  if (is(subcommand, "filter-branch")) return need("git filter-branch runs the commands it is given");
  return undefined;
};

const sshValued = named("-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w");

/** The host that `ssh`'s arguments `rest` name, past its options; undefined when it is not a literal word. */
const sshHost = (rest: ReadonlyArray<Word>): WordText | undefined => {
  const [next, ...after] = rest;
  if (next === undefined) return undefined;
  if (next.literal !== undefined && sshValued.has(next.literal)) return sshHost(after.slice(1));
  return isOption(next) ? sshHost(after) : next.literal;
};

/** Returns the units of a simple command whose words are `words`. */
const resolve = (words: ReadonlyArray<Word>, seen: Seen): ReadonlyArray<Unit> => {
  const [first, ...rest] = words;
  if (first === undefined) return [];
  const program = first.literal;
  if (program === undefined) return [opaque(words, need("its program's name is not written out"))];
  const base = basename(program);
  const options = wrappers.get(base);
  if (options !== undefined && !(base === WordText.make("command") && rest.some((word) => is(word, "-v", "-V")))) return wrapped(base, options, words, seen);
  const runner = projectRunners.get(base);
  if (runner !== undefined && literalOf(rest[0]) === runner && rest[1] !== undefined && !isOption(rest[1])) return resolve(rest.slice(1), seen);
  if (asAnotherUser.has(base)) return [opaque(words, need(`it runs as another user (${base})`))];
  if (notFollowed.has(base)) return [opaque(words, need(`${base} runs a command that is not followed`))];
  if (inlineProgram.has(base) && !rest.some((word) => is(word, "-f", "--file"))) return [opaque(words, need(`${base} runs a program written in the command`), codeOf("awk", awkProgram(rest)))];
  if (shells.has(base)) return shellUnits(words, seen);
  if (base === WordText.make("eval")) {
    const code = rest.map(literalOf);
    return code.length > 0 && code.every((word) => word !== undefined) ? unitsOfCode(WordText.make(code.join(" ")), words, seen) : [opaque(words, need("eval runs code that is not written out"))];
  }
  if (base === WordText.make("git")) {
    const normal = gitWords(words);
    if (typeof normal === "string") return [opaque(words, normal)];
    const running = gitRunning(normal);
    return running === undefined ? [unit(normal, grantOf(normal), { folders: seen.folders, writes: ownWrites(base, normal), reads: gitReads(words, normal) })] : [opaque(normal, running)];
  }
  if (base === WordText.make("trap")) {
    const past = rest.filter((word, at) => !(at === 0 && is(word, "-p", "-l", "--")));
    const code = past[0];
    if (code === undefined || is(code, "-")) return [unit(words, grantOf(words))];
    return code.literal === undefined ? [opaque(words, need("trap runs code that is not written out"))] : unitsOfCode(code.literal, words, seen);
  }
  // ssh, like docker and kubectl, is trusted as a whole: a command it runs on a host is not judged.
  if (base === WordText.make("ssh")) {
    const host = sshHost(rest);
    return [unit(words, host === undefined ? undefined : [program, host])];
  }
  if (seds.has(base)) return sedUnits(words, seen.folders);
  if (base === WordText.make("find")) return findUnits(words, seen);
  if (base === WordText.make(".") || base === WordText.make("source")) return [unit(words, rest[0] === undefined ? undefined : scriptGrant(words, rest[0]))];
  if (base === WordText.make("rg") && rest.some((word) => /^--pre(=|$)/.test(word.literal ?? word.text))) return [opaque(words, need("rg --pre runs a program on each file it searches"))];
  const bunEval = rest.findIndex((word) => is(word, "-e", "--eval", "-p", "--print"));
  if (base === WordText.make("bun") && bunEval !== -1) return [opaque(words, need("bun runs code written in the command"), codeOf("typescript", literalOf(rest[bunEval + 1])))];
  if (base === WordText.make("deno") && is(rest[0], "eval")) return [opaque(words, need("deno eval runs code written in the command"), codeOf("typescript", denoCode(rest.slice(1))))];
  const runtime = runtimeOf(base);
  if (runtime !== undefined) return runtimeUnits(words, runtime.inline, runtime.language, seen);
  const exported = declaring.has(base) ? steeringNeed(rest.flatMap((word) => present(word.literal).filter((value) => value.includes("=")))) : undefined;
  if (exported !== undefined) return [opaque(words, exported)];
  const changed = changesOf(base, words, seen.fedArgs);
  const reads = [...readsOf(base, words), ...(changed?.reads ?? [])];
  return [unit(words, grantOf(words), { folders: seen.folders, writes: ownWrites(base, words), changes: changed?.changes ?? [], fed: changed?.fed, reads })];
};

/** A wrapper's units: the program it runs, or the wrapper alone when it runs none. */
const wrapped = (base: WordText, options: WrapperOptions, words: ReadonlyArray<Word>, seen: Seen): ReadonlyArray<Unit> => {
  const past = pastOptions(options, words.slice(1));
  if (past === undefined) return [opaque(words, need(`it gives ${base} options that are not known`))];
  const assignments = base === WordText.make("env") ? past.slice(0, Math.max(0, past.findIndex((word) => !isAssignment(word)))).concat(past.every(isAssignment) ? past : []) : [];
  const steered = steeringNeed(assignments.map((word) => word.literal ?? word.text));
  if (steered !== undefined) return [opaque(words, steered)];
  const inner = past.slice(assignments.length);
  if (inner.length !== 0) return resolve(inner, base === WordText.make("xargs") ? { ...seen, fedText: false, fedBody: undefined, fedArgs: true } : seen);
  return base === WordText.make("xargs") ? resolve([{ text: WordText.make("echo"), literal: WordText.make("echo") }], seen) : [unit(words, grantOf(words))];
};

/** A shell runs code written out (`-c '…'`), code from its input, or a script. */
const shellUnits = (words: ReadonlyArray<Word>, seen: Seen): ReadonlyArray<Unit> => {
  const scan = (rest: ReadonlyArray<Word>, flags: ReadonlyArray<WordText>): { readonly flags: ReadonlyArray<WordText>; readonly operands: ReadonlyArray<Word> } => {
    const [next, ...after] = rest;
    const option = next?.literal;
    if (next === undefined || option === undefined || !(option.startsWith("-") || option.startsWith("+")) || option === WordText.make("-") || option === WordText.make("--"))
      return { flags, operands: option === WordText.make("--") ? after : rest };
    if (shellValued.has(option)) return scan(after.slice(1), flags);
    return scan(after, option.startsWith("--") ? flags : [...flags, ...option.slice(1).split("").map((each) => WordText.make(each))]);
  };
  const { flags, operands } = scan(words.slice(1), []);
  if (flags.includes(WordText.make("c"))) {
    const code = literalOf(operands[0]);
    return code === undefined ? [opaque(words, need("it runs code that is not written out"))] : unitsOfCode(code, words, seen);
  }
  const script = operands[0];
  if (flags.includes(WordText.make("s")) || script === undefined || is(script, "-") || seen.fedText) return [opaque(words, need("it runs code read from its input"), codeOf("bash", seen.fedBody))];
  return [unit(words, scriptGrant(words, script))];
};

/** The grant for running `script`: the program and the script, when the script is literal and comes straight after the program. */
const scriptGrant = (words: ReadonlyArray<Word>, script: Word): ReadonlyArray<WordText> | undefined => {
  const program = literalOf(words[0]);
  return program !== undefined && script.literal !== undefined && words[1] === script ? [program, script.literal] : undefined;
};

/** A runtime runs code written in the command (its `inline` options), code from its input, a module (`-m`), or a script. */
/** Whether `word` is one of the `inline` options, alone or ending a cluster of short options (`perl -ne`, `ruby -pe`). */
const isInline = (word: Word, inline: ReadonlySet<WordText>): boolean => {
  const option = word.literal;
  if (option === undefined) return false;
  return inline.has(option) || (/^-[A-Za-z0-9]{2,}$/.test(option) && inline.has(WordText.make(`-${option.slice(-1)}`)));
};

const runtimeUnits = (words: ReadonlyArray<Word>, inline: ReadonlySet<WordText>, language: CodeLanguage, seen: Seen): ReadonlyArray<Unit> => {
  const rest = words.slice(1);
  const at = rest.findIndex((word) => isInline(word, inline));
  if (at !== -1) return [opaque(words, need("it runs code written in the command"), codeOf(language, literalOf(rest[at + 1])))];
  const program = literalOf(words[0]);
  const module = literalOf(rest[1]);
  if (is(rest[0], "-m") && program !== undefined && module !== undefined) return [unit(words, [program, WordText.make("-m"), module])];
  if (rest.some((word) => is(word, "-m"))) return [unit(words, undefined)];
  const script = rest.find((word) => !isOption(word));
  if (script === undefined || is(script, "-") || seen.fedText) return [opaque(words, need("it runs code read from its input"), codeOf(language, seen.fedBody))];
  return [unit(words, scriptGrant(words, script))];
};

const execOptions = named("-exec", "-execdir", "-ok", "-okdir");
const fileOptions = named("-fprint", "-fprint0", "-fprintf", "-fls");

/** `find`, and each command its `-exec`-style options run, each a unit. */
const findLeading = named("-H", "-L", "-P");
const findExpression = named("(", ")", "!", ",");

/** `find`'s starting points: the operands before its expression, past `-H`, `-L`, `-P`, `-D` and `-O`. */
const findStarts = (rest: ReadonlyArray<Word>): ReadonlyArray<Word> => {
  const [next, ...after] = rest;
  if (next === undefined) return [];
  const option = next.literal;
  if (option !== undefined && findLeading.has(option)) return findStarts(after);
  if (is(next, "-D")) return findStarts(after.slice(1));
  if (option !== undefined && /^-O\d*$/.test(option)) return findStarts(after);
  const end = rest.findIndex((word) => isOption(word) || (word.literal !== undefined && findExpression.has(word.literal)));
  return end === -1 ? rest : rest.slice(0, end);
};

/**
 * `find`'s units: `find` itself, and each program its `-exec`, `-execdir`, `-ok` and `-okdir` run.
 * `find` reads its starting points; with `-delete` it deletes what it finds under them, and writes the
 * files its `-fprint` options name.
 */
const findUnits = (words: ReadonlyArray<Word>, seen: Seen): ReadonlyArray<Unit> => {
  const starts = findStarts(words.slice(1));
  const outsideStarts = starts.filter((word) => escapes(word, seen.folders));
  const scan = (remaining: ReadonlyArray<Word>, own: ReadonlyArray<Word>, inner: ReadonlyArray<Unit>, writes: ReadonlyArray<Word>, deletes: boolean): ReadonlyArray<Unit> => {
    const [next, ...after] = remaining;
    if (next === undefined) {
      const changes = deletes ? starts.map((word) => ({ verb: "deletes" as const, word })) : [];
      return [unit(own, grantOf(own), { folders: seen.folders, writes, changes, reads: deletes ? [] : starts }), ...inner];
    }
    const option = next.literal;
    if (option !== undefined && execOptions.has(option)) {
      const end = after.findIndex((word) => is(word, ";", "+"));
      if (end === -1) return [opaque(words, need(`find ${option} has no end (; or +)`))];
      return scan(after.slice(end + 1), own, [...inner, ...resolve(after.slice(0, end), { ...seen, fedText: false, fedBody: undefined, fedArgs: false })], writes, deletes);
    }
    if (option === WordText.make("-delete")) return scan(after, [...own, next], inner, outsideStarts.length === 0 ? [...writes, literalWord("the files that find finds")] : writes, true);
    if (option !== undefined && fileOptions.has(option)) {
      const file = after[0];
      return scan(after.slice(1), [...own, next, ...present(file)], inner, [...writes, ...present(file)], deletes);
    }
    return scan(after, [...own, next], inner, writes, deletes);
  };
  return scan(words.slice(1), words.slice(0, 1), [], [], false);
};

// —— Text written to a file ——

/** The text a segment's here-document or here-string gives as input, with the line break a here-string adds, and whether the shell expands it. */
const fedTextOf = (segment: Segment): { readonly text: WordText; readonly expands: boolean } | undefined => {
  const fed = segment.redirects.find((redirect) => redirect.op === "<<" || redirect.op === "<<<");
  if (fed?.body === undefined) return undefined;
  return { text: WordText.make(fed.op === "<<<" ? `${fed.body}\n` : fed.body), expands: fed.expands === true };
};

/**
 * The text that a simple segment's program prints, when its words show it: `cat` (or `cat -`) given a
 * here-document or here-string, or `echo` with literal words and no option or backslash, whose
 * meanings differ between shells. Undefined for anything else.
 */
const printedTextOf = (segment: Segment, fed: ReturnType<typeof fedTextOf>): { readonly text: WordText; readonly expands: boolean } | undefined => {
  const words = segment.words.map(literalOf);
  const [program, ...rest] = words;
  if (program === undefined || words.some((word) => word === undefined)) return undefined;
  if (basename(program) === WordText.make("cat")) return rest.length === 0 || (rest.length === 1 && rest[0] === WordText.make("-")) ? fed : undefined;
  if (basename(program) !== WordText.make("echo")) return undefined;
  const args = rest.filter((word) => word !== undefined);
  // echo's options and backslashes mean different things in different shells: macOS's /bin/sh prints `-n`.
  if (args.some((word) => word.startsWith("-") || word.includes("\\"))) return undefined;
  return { text: WordText.make(`${args.join(" ")}\n`), expands: false };
};

/** `word` as a path to write: a literal word, or one from `~` with nothing else to expand (`~/notes.md`, which the shell expands to the home folder). */
const writtenPath = (word: Word | undefined): WordText | undefined =>
  word?.literal ?? (word !== undefined && /^~[A-Za-z0-9_.-]*(\/[^$`"'\\*?[\]{}\s]*)?$/.test(word.text) ? word.text : undefined);

/** The file a segment's standard output goes to: its one redirect that writes a file (`>`, `>|` or `>>`, whose name is a literal word or a path from `~`); undefined when it has another, or none. */
const outputFileOf = (segment: Segment): { readonly path: WordText; readonly append: boolean } | undefined => {
  const files = segment.redirects.filter((redirect) => redirectWrites({ ...segment, redirects: [redirect] }).length > 0);
  const [only] = files;
  const path = writtenPath(only?.target);
  if (files.length !== 1 || only === undefined || path === undefined || !(only.fd === undefined || only.fd === 1) || ![">", ">|", ">>"].includes(only.op)) return undefined;
  return { path, append: only.op === ">>" };
};

/** `tee`'s detail, when it is given text written in the command and writes one file whose name is a literal word (`tee -a notes.md <<'EOF'`). */
const teeWrites = (words: ReadonlyArray<Word>, fed: ReturnType<typeof fedTextOf>): Writes | undefined => {
  if (fed === undefined || words[0]?.literal === undefined || basename(words[0].literal) !== WordText.make("tee")) return undefined;
  const options = words.slice(1).filter(isOption);
  const files = words.slice(1).filter((word) => !isOption(word));
  const path = files.length === 1 ? writtenPath(files[0]) : undefined;
  if (path === undefined || options.some((word) => !is(word, "-a", "--append"))) return undefined;
  return { _tag: "Writes", path, text: CodeText.make(fed.text), append: options.length > 0, expands: fed.expands };
};

/** Returns the units of `segment`. A call to a function in `functions` is not a unit. */
const segmentUnits = (segment: Segment, functions: ReadonlySet<WordText>, seen: Seen): ReadonlyArray<Unit> => {
  const writes = redirectWrites(segment);
  const reads = segment.redirects.flatMap((redirect) => (redirect.op === "<" ? present(fileOf(redirect.target)) : []));
  const fed = fedTextOf(segment);
  const printed = segment.kind === "simple" ? printedTextOf(segment, fed) : undefined;
  const output = printed === undefined ? undefined : outputFileOf(segment);
  const detail: Writes | undefined = printed === undefined || output === undefined ? undefined : { _tag: "Writes", ...output, text: CodeText.make(printed.text), expands: printed.expands };
  const written = writes.length === 0 && reads.length === 0 ? [] : [unit([], undefined, { folders: seen.folders, writes, reads, ...(detail === undefined ? {} : { detail }) })];
  if (segment.kind !== "simple") return written;
  const steered = steeringNeed(segment.assignments);
  if (steered !== undefined) return [opaque(segment.words, steered), ...written];
  const program = segment.words[0]?.literal;
  if (program !== undefined && functions.has(program)) return written;
  const resolved = resolve(segment.words, { ...seen, fedText: segment.fed_text, fedBody: fed?.text });
  const teed = teeWrites(segment.words, fed);
  return [...(teed === undefined ? resolved : resolved.map((each) => (each.words[0] === segment.words[0] ? { ...each, detail: teed } : each))), ...written];
};

/** The texts a command's units write to files, in order, each with whether a `cd`, `pushd` or `popd` before it may have moved the folder its path is relative to. */
export const textsWritten = (units: ReadonlyArray<Unit>): ReadonlyArray<{ readonly writes: Writes; readonly moved: boolean }> =>
  units.flatMap((each, at) =>
    each.detail?._tag === "Writes" ? [{ writes: each.detail, moved: units.slice(0, at).some((before) => ["cd", "pushd", "popd"].includes(basename(before.words[0]?.literal ?? WordText.make("")))) }] : [],
  );

const unitsAt = (command: ShellCommand, segmentsOf: SegmentsOf, depth: number, folders: Folders | undefined): Units => {
  const split = segmentsOf(command);
  if (split._tag === "Unparsed") return split;
  const functions = new Set(split.segments.flatMap((segment) => (segment.kind === "function_definition" ? present(segment.words[0]?.literal) : [])));
  return { _tag: "Units", units: split.segments.flatMap((segment) => segmentUnits(segment, functions, { segmentsOf, depth, fedText: false, fedBody: undefined, fedArgs: false, folders })) };
};

/** Returns the units of `command`, split by `segmentsOf`, with the paths they read judged against `folders`. */
export const unitsOf = (command: ShellCommand, segmentsOf: SegmentsOf, folders?: Folders): Units => unitsAt(command, segmentsOf, 0, folders);
