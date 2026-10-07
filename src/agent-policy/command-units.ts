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
 * `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/tty` and file descriptors are not files; a target
 * that is not a literal word is a file all the same.
 *
 * Setting a variable that chooses which programs or code run (`PATH`, `LD_*`, `DYLD_*`, `GIT_*`,
 * `BASH_ENV`, `NODE_OPTIONS`, …) for a command, with `env`, or with `export`, makes its unit opaque.
 *
 * The tables follow exo-project's corpus of coding agents' commands (spikes 01_2 and 01_3).
 */

import { Schema } from "effect";
import { type Segment, type SegmentsOf, ShellCommand, type UnparsedReason, type Word, WordText } from "./command-segments.ts";

/** Why a unit's words do not show what it runs. */
export const NeedText = Schema.String.pipe(Schema.brand("agent-policy/NeedText"));
export type NeedText = typeof NeedText.Type;

/** A program that a command runs, after the programs around it that only run it. */
export interface Unit {
  /** Its words from the program on, as the command writes them. Empty for a segment that runs no program but writes a file. */
  readonly words: ReadonlyArray<Word>;
  /** What "allow for the rest of the session" names; undefined when only the one call can be allowed. */
  readonly grant: ReadonlyArray<WordText> | undefined;
  /** The files it writes, as written. */
  readonly writes: ReadonlyArray<WordText>;
  /** Why its words do not show what it runs; undefined when they do. */
  readonly opaque: NeedText | undefined;
}

export type Units = { readonly _tag: "Units"; readonly units: ReadonlyArray<Unit> } | { readonly _tag: "Unparsed"; readonly reason: UnparsedReason };

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

const unit = (words: ReadonlyArray<Word>, grant: ReadonlyArray<WordText> | undefined, writes: ReadonlyArray<WordText> = []): Unit => ({ words, grant, writes, opaque: undefined });
const opaque = (words: ReadonlyArray<Word>, why: NeedText): Unit => ({ words, grant: undefined, writes: [], opaque: why });

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
  [WordText.make("npm"), named("run", "run-script", "exec")],
  [WordText.make("pnpm"), named("run", "dlx", "exec")],
  [WordText.make("yarn"), named("run", "dlx")],
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
const inlineProgram = named("awk", "gawk", "mawk", "nawk", "sed", "gsed");
const declaring = named("export", "declare", "typeset", "local", "readonly");

/** Each runtime, and the options with which it runs code written in the command. */
const runtimes: ReadonlyMap<WordText, ReadonlySet<WordText>> = new Map([
  [WordText.make("python"), named("-c")],
  [WordText.make("python3"), named("-c")],
  [WordText.make("node"), named("-e", "--eval", "-p", "--print")],
  [WordText.make("ruby"), named("-e")],
  [WordText.make("perl"), named("-e", "-E")],
  [WordText.make("php"), named("-r")],
  [WordText.make("lua"), named("-e")],
  [WordText.make("osascript"), named("-e")],
  [WordText.make("Rscript"), named("-e")],
  [WordText.make("pwsh"), named("-c", "-Command", "-command")],
  [WordText.make("powershell"), named("-c", "-Command", "-command")],
]);

/** Returns the runtime's inline options: `python3.12` is `python3`. */
const runtimeOf = (base: WordText): ReadonlySet<WordText> | undefined => runtimes.get(WordText.make(base.replace(/^python3\.\d+$/, "python3")));

// —— Files written ——

const notFiles = named("/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty");

/** Returns the file that `target` names, as written; undefined when it names no file. */
const fileOf = (target: Word | undefined): WordText | undefined => {
  if (target === undefined) return undefined;
  const value = target.literal;
  if (value === undefined) return target.text;
  return notFiles.has(value) || value.startsWith("/dev/fd/") ? undefined : value;
};

/** The files that `segment`'s redirects write. */
const redirectWrites = (segment: Segment): ReadonlyArray<WordText> =>
  segment.redirects.flatMap((redirect) => {
    if (redirect.op === ">&") {
      const value = redirect.target?.literal;
      return value !== undefined && /^(\d+-?|-)$/.test(value) ? [] : present(fileOf(redirect.target));
    }
    return [">", ">>", ">|", "&>", "&>>", "<>"].includes(redirect.op) ? present(fileOf(redirect.target)) : [];
  });

/** The files a program writes through its own options and arguments: `tee`, `dd of=`, `sort -o`, `git --output`. */
const ownWrites = (base: WordText, words: ReadonlyArray<Word>): ReadonlyArray<WordText> => {
  const args = words.slice(1);
  if (base === WordText.make("tee")) return args.filter((word) => !isOption(word)).map((word) => word.literal ?? word.text);
  if (base === WordText.make("dd")) return args.flatMap((word) => (word.literal?.startsWith("of=") === true ? [WordText.make(word.literal.slice(3))] : []));
  const valued = (short: Name | undefined, long: Name) =>
    args.flatMap((word, at) => {
      const value = word.literal;
      if (value === undefined) return [];
      if (value === short || value === long) return present(args[at + 1]).map((file) => file.literal ?? file.text);
      return value.startsWith(`${long}=`) ? [WordText.make(value.slice(long.length + 1))] : [];
    });
  if (base === WordText.make("sort")) return valued("-o", "--output");
  if (base === WordText.make("git")) return valued(undefined, "--output");
  return [];
};

// —— Units ——

interface Seen {
  readonly segmentsOf: SegmentsOf;
  readonly depth: number;
  /** Whether the program's input is text written in the command (a here-document or here-string). */
  readonly fedText: boolean;
}

/** Returns the units of code written out as `code`, one level deeper; opaque when that is too deep or the code does not parse. */
const unitsOfCode = (code: WordText, around: ReadonlyArray<Word>, seen: Seen): ReadonlyArray<Unit> => {
  if (seen.depth >= maxDepth) return [opaque(around, need(`it runs code nested more than ${maxDepth} levels deep`))];
  const inner = unitsAt(ShellCommand.make(code), seen.segmentsOf, seen.depth + 1);
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
  if (inlineProgram.has(base) && !rest.some((word) => is(word, "-f", "--file"))) return [opaque(words, need(`${base} runs a program written in the command`))];
  if (shells.has(base)) return shellUnits(words, seen);
  if (base === WordText.make("eval")) {
    const code = rest.map(literalOf);
    return code.length > 0 && code.every((word) => word !== undefined) ? unitsOfCode(WordText.make(code.join(" ")), words, seen) : [opaque(words, need("eval runs code that is not written out"))];
  }
  if (base === WordText.make("git")) {
    const normal = gitWords(words);
    return typeof normal === "string" ? [opaque(words, normal)] : [unit(normal, grantOf(normal), ownWrites(base, normal))];
  }
  if (base === WordText.make("find")) return findUnits(words, seen);
  if (base === WordText.make(".") || base === WordText.make("source")) return [unit(words, rest[0] === undefined ? undefined : scriptGrant(words, rest[0]))];
  if (base === WordText.make("rg") && rest.some((word) => /^--pre(=|$)/.test(word.literal ?? word.text))) return [opaque(words, need("rg --pre runs a program on each file it searches"))];
  if (base === WordText.make("bun") && rest.some((word) => is(word, "-e", "--eval", "-p", "--print"))) return [opaque(words, need("bun runs code written in the command"))];
  if (base === WordText.make("deno") && is(rest[0], "eval")) return [opaque(words, need("deno eval runs code written in the command"))];
  const inline = runtimeOf(base);
  if (inline !== undefined) return runtimeUnits(words, inline, seen);
  const exported = declaring.has(base) ? steeringNeed(rest.flatMap((word) => present(word.literal).filter((value) => value.includes("=")))) : undefined;
  if (exported !== undefined) return [opaque(words, exported)];
  return [unit(words, grantOf(words), ownWrites(base, words))];
};

/** A wrapper's units: the program it runs, or the wrapper alone when it runs none. */
const wrapped = (base: WordText, options: WrapperOptions, words: ReadonlyArray<Word>, seen: Seen): ReadonlyArray<Unit> => {
  const past = pastOptions(options, words.slice(1));
  if (past === undefined) return [opaque(words, need(`it gives ${base} options that are not known`))];
  const assignments = base === WordText.make("env") ? past.slice(0, Math.max(0, past.findIndex((word) => !isAssignment(word)))).concat(past.every(isAssignment) ? past : []) : [];
  const steered = steeringNeed(assignments.map((word) => word.literal ?? word.text));
  if (steered !== undefined) return [opaque(words, steered)];
  const inner = past.slice(assignments.length);
  if (inner.length !== 0) return resolve(inner, { ...seen, fedText: base === WordText.make("xargs") ? false : seen.fedText });
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
  if (flags.includes(WordText.make("s")) || script === undefined || is(script, "-") || seen.fedText) return [opaque(words, need("it runs code read from its input"))];
  return [unit(words, scriptGrant(words, script))];
};

/** The grant for running `script`: the program and the script, when the script is literal and comes straight after the program. */
const scriptGrant = (words: ReadonlyArray<Word>, script: Word): ReadonlyArray<WordText> | undefined => {
  const program = literalOf(words[0]);
  return program !== undefined && script.literal !== undefined && words[1] === script ? [program, script.literal] : undefined;
};

/** A runtime runs code written in the command (its `inline` options), code from its input, a module (`-m`), or a script. */
const runtimeUnits = (words: ReadonlyArray<Word>, inline: ReadonlySet<WordText>, seen: Seen): ReadonlyArray<Unit> => {
  const rest = words.slice(1);
  if (rest.some((word) => word.literal !== undefined && inline.has(word.literal))) return [opaque(words, need("it runs code written in the command"))];
  const program = literalOf(words[0]);
  const module = literalOf(rest[1]);
  if (is(rest[0], "-m") && program !== undefined && module !== undefined) return [unit(words, [program, WordText.make("-m"), module])];
  if (rest.some((word) => is(word, "-m"))) return [unit(words, undefined)];
  const script = rest.find((word) => !isOption(word));
  if (script === undefined || is(script, "-") || seen.fedText) return [opaque(words, need("it runs code read from its input"))];
  return [unit(words, scriptGrant(words, script))];
};

const execOptions = named("-exec", "-execdir", "-ok", "-okdir");
const fileOptions = named("-fprint", "-fprint0", "-fprintf", "-fls");

/** `find`, and each command its `-exec`-style options run, each a unit. */
const findUnits = (words: ReadonlyArray<Word>, seen: Seen): ReadonlyArray<Unit> => {
  const scan = (remaining: ReadonlyArray<Word>, own: ReadonlyArray<Word>, inner: ReadonlyArray<Unit>, writes: ReadonlyArray<WordText>): ReadonlyArray<Unit> => {
    const [next, ...after] = remaining;
    if (next === undefined) return [unit(own, grantOf(own), writes), ...inner];
    const option = next.literal;
    if (option !== undefined && execOptions.has(option)) {
      const end = after.findIndex((word) => is(word, ";", "+"));
      if (end === -1) return [opaque(words, need(`find ${option} has no end (; or +)`))];
      return scan(after.slice(end + 1), own, [...inner, ...resolve(after.slice(0, end), { ...seen, fedText: false })], writes);
    }
    if (option === WordText.make("-delete")) return scan(after, [...own, next], inner, [...writes, WordText.make("the files that find finds")]);
    if (option !== undefined && fileOptions.has(option)) {
      const file = after[0];
      return scan(after.slice(1), [...own, next, ...present(file)], inner, [...writes, ...present(file).map((each) => each.literal ?? each.text)]);
    }
    return scan(after, [...own, next], inner, writes);
  };
  return scan(words.slice(1), words.slice(0, 1), [], []);
};

/** Returns the units of `segment`. A call to a function in `functions` is not a unit. */
const segmentUnits = (segment: Segment, functions: ReadonlySet<WordText>, seen: Seen): ReadonlyArray<Unit> => {
  const writes = redirectWrites(segment);
  const written = writes.length === 0 ? [] : [unit([], undefined, writes)];
  if (segment.kind !== "simple") return written;
  const steered = steeringNeed(segment.assignments);
  if (steered !== undefined) return [opaque(segment.words, steered), ...written];
  const program = segment.words[0]?.literal;
  if (program !== undefined && functions.has(program)) return written;
  return [...resolve(segment.words, { ...seen, fedText: segment.fed_text }), ...written];
};

const unitsAt = (command: ShellCommand, segmentsOf: SegmentsOf, depth: number): Units => {
  const split = segmentsOf(command);
  if (split._tag === "Unparsed") return split;
  const functions = new Set(split.segments.flatMap((segment) => (segment.kind === "function_definition" ? present(segment.words[0]?.literal) : [])));
  return { _tag: "Units", units: split.segments.flatMap((segment) => segmentUnits(segment, functions, { segmentsOf, depth, fedText: false })) };
};

/** Returns the units of `command`, split by `segmentsOf`. */
export const unitsOf = (command: ShellCommand, segmentsOf: SegmentsOf): Units => unitsAt(command, segmentsOf, 0);
