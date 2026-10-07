/**
 * A `sed` script, read: its commands (`parse`); what it does besides transforming text, which the
 * permission policy judges (`analyse`: runs shell commands, writes files, reads files); and what it
 * does, in plain English, for the question that asks about it (`explain`).
 *
 * The script is read as GNU sed reads it, a superset of BSD sed's commands:
 *
 * - commands separated by `;` or newlines, each with up to two addresses (a line number, `$`,
 *   `/regex/` or `\cregexc` with `I` or `M`, `first~step`, `+N`, `~N`) and an optional `!`;
 * - `{` and `}`; `#` comments; labels (`:`) and branches (`b`, `t`, `T`);
 * - `a`, `i` and `c` with their text, to the end of the line;
 * - `s` and `y` with any delimiter, backslash escapes included;
 * - `r`, `R`, `w` and `W`, whose file name runs to the end of the line, `;` included.
 *
 * A script with anything else, or that ends inside a command, is not understood: `parse` returns
 * undefined, and the policy treats the call as code it cannot judge.
 *
 * `e` (and the `e` flag of `s`) runs shell commands; `w`, `W` and the `w` flag of `s` write files;
 * `r` and `R` read them.
 */

import { Schema } from "effect";

/** A sed script, as written in a command. */
export const SedScript = Schema.String.pipe(Schema.brand("agent-policy/SedScript"));
export type SedScript = typeof SedScript.Type;

/** A file name that a script names. */
export const SedFile = Schema.String.pipe(Schema.brand("agent-policy/SedFile"));
export type SedFile = typeof SedFile.Type;

/** A line of an explanation, in plain English. */
export const Explanation = Schema.String.pipe(Schema.brand("agent-policy/Explanation"));
export type Explanation = typeof Explanation.Type;

/** A line of an explanation, and how deep it sits: 0 for what is read, 1 for each command, 2 and more for the commands in a block. */
export const ExplanationLine = Schema.Struct({ depth: Schema.Int, text: Explanation });
export type ExplanationLine = typeof ExplanationLine.Type;

/** One character of a script. */
type Character = SedScript[number];

/** One command: its addresses as written (`1,5`, `/foo/`, `$`), whether `!` negates them, its letter, and what it takes. */
export interface SedCommand {
  readonly addresses: SedScript;
  readonly negated: boolean;
  readonly letter: Character;
  /** `s`: the pattern; `y`: the characters changed. */
  readonly pattern?: SedScript;
  /** `s`: the replacement; `y`: the characters they become. */
  readonly replacement?: SedScript;
  /** `s`: its flags (`g`, a number, `p`, `i`, `e`). */
  readonly flags?: SedScript;
  /** `a`, `i`, `c`, `e`: the text; `b`, `t`, `T`, `:`: the label; `q`, `Q`: the exit code. */
  readonly text?: SedScript;
  /** `r`, `R`, `w`, `W`, and `s`'s `w` flag: the file. */
  readonly file?: SedFile;
  /** `{`: the commands of the block. */
  readonly block?: ReadonlyArray<SedCommand>;
}

/** What a script does besides transforming text. */
export interface SedEffects {
  readonly executes: boolean;
  readonly writes: ReadonlyArray<SedFile>;
  readonly reads: ReadonlyArray<SedFile>;
}

type Read = { readonly at: number; readonly commands: ReadonlyArray<SedCommand> } | undefined;
type One = { readonly at: number; readonly command: SedCommand } | undefined;

const scriptOf = (text: Parameters<typeof SedScript.make>[0]): SedScript => SedScript.make(text);
const isBlank = (character: Character | undefined): boolean => character === " " || character === "\t";
const skipBlanks = (script: SedScript, at: number): number => (isBlank(script[at]) ? skipBlanks(script, at + 1) : at);
const lineEnd = (script: SedScript, at: number): number => {
  const end = script.indexOf("\n", at);
  return end === -1 ? script.length : end;
};

/** Returns the index after the delimited part that starts at `at` (just past an opening `delimiter`), or -1 when it does not end. */
const pastDelimited = (script: SedScript, at: number, delimiter: Character): number => {
  const character = script[at];
  if (character === undefined || character === "\n") return -1;
  if (character === "\\") return pastDelimited(script, at + 2, delimiter);
  return character === delimiter ? at + 1 : pastDelimited(script, at + 1, delimiter);
};

/** Returns the index after one address at `at`, or `at` when there is none, or -1 when it does not end. */
const pastAddress = (script: SedScript, at: number): number => {
  const character = script[at];
  if (character === "/") return pastDelimited(script, at + 1, "/");
  if (character === "\\") {
    const delimiter = script[at + 1];
    return delimiter === undefined ? -1 : pastDelimited(script, at + 2, delimiter);
  }
  if (character === "$") return at + 1;
  const digits = /^[+~]?\d+(~\d+)?/.exec(script.slice(at));
  return digits === null ? at : at + digits[0].length;
};

/** Returns the index after the addresses at `at` (with their `I`/`M` flags and a range's `,`), or -1. */
const pastAddresses = (script: SedScript, at: number): number => {
  const first = pastAddress(script, at);
  if (first === -1) return -1;
  const flagged = first > at ? first + (/^[IM]*/.exec(script.slice(first))?.[0].length ?? 0) : first;
  const comma = skipBlanks(script, flagged);
  const range = script[comma] === "," ? pastAddress(script, skipBlanks(script, comma + 1)) : flagged;
  return range === -1 ? -1 : range + (/^[IM]*/.exec(script.slice(range))?.[0].length ?? 0);
};

/** Returns the index after a command's end: blanks, then `;`, a newline, `}` or the end. -1 when something else follows. */
const pastEnd = (script: SedScript, at: number): number => {
  const next = skipBlanks(script, at);
  const character = script[next];
  if (character === undefined || character === "}") return next;
  if (character === ";" || character === "\n") return next + 1;
  return character === "#" ? lineEnd(script, next) : -1;
};

/** Commands whose text, label or version runs to the end of the line. */
const textCommands: ReadonlySet<Character> = new Set(["a", "i", "c", ":", "v", "e"]);
/** Branches, which take a label to `;`, `}` or the end of the line. */
const branches: ReadonlySet<Character> = new Set(["b", "t", "T"]);
/** Commands that take an optional number. */
const numbered: ReadonlySet<Character> = new Set(["q", "Q", "l", "L"]);
/** Commands that take a file name, to the end of the line. */
const fileCommands: ReadonlySet<Character> = new Set(["r", "R", "w", "W"]);
/** Commands that take nothing. */
const plain: ReadonlySet<Character> = new Set(["=", "d", "D", "g", "G", "h", "H", "n", "N", "p", "P", "x", "z", "F"]);

/** Reads `s` or `y` at `at`, its delimiter next. */
const delimited = (script: SedScript, at: number, base: SedCommand, ended: (command: SedCommand, from: number) => One): One => {
  const after = at + 1;
  const delimiter = script[after];
  if (delimiter === undefined || delimiter === "\n" || delimiter === "\\") return undefined;
  const pattern = pastDelimited(script, after + 1, delimiter);
  const replacement = pattern === -1 ? -1 : pastDelimited(script, pattern, delimiter);
  if (replacement === -1) return undefined;
  const parts = { pattern: scriptOf(script.slice(after + 1, pattern - 1)), replacement: scriptOf(script.slice(pattern, replacement - 1)) };
  if (base.letter === "y") return ended({ ...base, ...parts }, replacement);
  const flags = /^[gpiImMe0-9]*/.exec(script.slice(replacement))?.[0] ?? "";
  const afterFlags = replacement + flags.length;
  if (script[afterFlags] !== "w") return ended({ ...base, ...parts, flags: scriptOf(flags) }, afterFlags);
  const end = lineEnd(script, afterFlags + 1);
  const file = script.slice(skipBlanks(script, afterFlags + 1), end).trim();
  return file === "" ? undefined : { at: end, command: { ...base, ...parts, flags: scriptOf(flags), file: SedFile.make(file) } };
};

/** Reads one command at `at`, its addresses already read (`addresses`, `negated`). */
const one = (script: SedScript, at: number, addresses: SedScript, negated: boolean): One => {
  const letter = script[at];
  if (letter === undefined) return undefined;
  const after = at + 1;
  const base: SedCommand = { addresses, negated, letter };
  const ended = (command: SedCommand, from: number): One => {
    const end = pastEnd(script, from);
    return end === -1 ? undefined : { at: end, command };
  };
  const restOfLine = () => scriptOf(script.slice(skipBlanks(script, after), lineEnd(script, after)).replace(/^\\/, "").trim());
  if (letter === "{") {
    const block = commands(script, after, true);
    return block === undefined ? undefined : ended({ ...base, block: block.commands }, block.at);
  }
  if (letter === "s" || letter === "y") return delimited(script, at, base, ended);
  if (textCommands.has(letter)) return { at: lineEnd(script, after), command: { ...base, text: restOfLine() } };
  if (branches.has(letter)) {
    const label = /^[^;\n}]*/.exec(script.slice(after))?.[0] ?? "";
    return ended({ ...base, text: scriptOf(label.trim()) }, after + label.length);
  }
  if (fileCommands.has(letter)) {
    const file = restOfLine();
    return file === "" ? undefined : { at: lineEnd(script, after), command: { ...base, file: SedFile.make(file) } };
  }
  if (numbered.has(letter)) {
    const number = /^\s*\d*/.exec(script.slice(after))?.[0] ?? "";
    return ended({ ...base, ...(number.trim() === "" ? {} : { text: scriptOf(number.trim()) }) }, after + number.length);
  }
  return plain.has(letter) ? ended(base, after) : undefined;
};

/** Reads the commands from `at` to the end of the script, or to the `}` that closes a block when `inBlock`. */
const commands = (script: SedScript, at: number, inBlock: boolean, sofar: ReadonlyArray<SedCommand> = []): Read => {
  const start = skipBlanks(script, at);
  const character = script[start];
  if (character === undefined) return inBlock ? undefined : { at: start, commands: sofar };
  if (character === "\n" || character === ";") return commands(script, start + 1, inBlock, sofar);
  if (character === "#") return commands(script, lineEnd(script, start), inBlock, sofar);
  if (character === "}") return inBlock ? { at: start + 1, commands: sofar } : undefined;
  const addressed = pastAddresses(script, start);
  if (addressed === -1) return undefined;
  const bang = skipBlanks(script, addressed);
  const negated = script[bang] === "!";
  const read = one(script, negated ? skipBlanks(script, bang + 1) : bang, scriptOf(script.slice(start, addressed).trim()), negated);
  return read === undefined ? undefined : commands(script, read.at, inBlock, [...sofar, read.command]);
};

/** Returns the commands of `script`; undefined when it is not understood. */
export const parse = (script: SedScript): ReadonlyArray<SedCommand> | undefined => commands(script, 0, false)?.commands;

const flatten = (all: ReadonlyArray<SedCommand>): ReadonlyArray<SedCommand> => all.flatMap((command) => [command, ...flatten(command.block ?? [])]);

/** Returns what `commands` (a parsed script) do besides transforming text. */
export const effectsOf = (parsed: ReadonlyArray<SedCommand>): SedEffects => {
  const all = flatten(parsed);
  const files = (letters: ReadonlyArray<Character>) => all.flatMap((command) => (letters.includes(command.letter) && command.file !== undefined ? [command.file] : []));
  return {
    executes: all.some((command) => command.letter === "e" || (command.letter === "s" && command.flags?.includes("e") === true)),
    writes: [...files(["w", "W"]), ...all.flatMap((command) => (command.letter === "s" && command.file !== undefined ? [command.file] : []))],
    reads: files(["r", "R"]),
  };
};

/** Returns what `script` does besides transforming text; undefined when it is not understood. */
export const analyse = (script: SedScript): SedEffects | undefined => {
  const parsed = parse(script);
  return parsed === undefined ? undefined : effectsOf(parsed);
};

// —— Explaining ——

type Text = Parameters<typeof Explanation.make>[0];
const said = (text: Text): Explanation => Explanation.make(text);
const quoted = (text: SedScript | undefined): Explanation => said(`\`${text ?? ""}\``);

/** One address, in plain English. */
const describeAddress = (address: SedScript): Explanation => {
  const regex = /^(?:\/(.*)\/|\\(.)(.*)\2)([IM]*)$/.exec(address);
  if (regex !== null) return said(`lines matching ${quoted(scriptOf(regex[1] ?? regex[3] ?? ""))}${regex[4]?.includes("I") === true ? " (ignoring case)" : ""}`);
  if (address === "$") return said("the last line");
  const step = /^(\d+)~(\d+)$/.exec(address);
  if (step !== null) return said(`every line ${step[2]} apart, from line ${step[1]}`);
  return said(`line ${address}`);
};

/** A command's addresses, in plain English: when it has none, "every line", or "those lines" inside a block. */
const describeAddresses = (command: SedCommand, inBlock: boolean): Explanation => {
  const text = command.addresses;
  if (text === "") return said(command.negated ? "no line" : inBlock ? "those lines" : "every line");
  const split = /^(\/(?:[^/\\]|\\.)*\/[IM]*|[^,]+?)\s*(?:,\s*(.+))?$/.exec(text);
  const first = scriptOf(split?.[1] ?? text);
  const second = split?.[2] === undefined ? undefined : scriptOf(split[2]);
  const lines = (() => {
    if (second === undefined) return describeAddress(first);
    if (/^\d+$/.test(first) && /^\d+$/.test(second)) return said(`lines ${first} to ${second}`);
    if (second.startsWith("+")) return said(`${describeAddress(first)} and the ${second.slice(1)} lines after each`);
    return said(`from ${describeAddress(first)} to ${describeAddress(second)}`);
  })();
  return command.negated ? said(`every line except ${lines}`) : lines;
};

/** Which matches of `pattern` the `s` command's flags replace, in plain English: `g` is every match; a number N is match N, or with `g` every match from match N; `i` ignores case. */
const matchesOf = (flags: SedScript | undefined, pattern: SedScript | undefined): Explanation => {
  const number = /\d+/.exec(flags ?? "")?.[0];
  const caseless = /[iI]/.test(flags ?? "") ? " (ignoring case)" : "";
  if (flags?.includes("g") === true) return said(`every match of ${quoted(pattern)}${caseless}${number === undefined ? "" : ` from match ${number}`}`);
  return said(`${number === undefined ? "the first match" : `match ${number}`} of ${quoted(pattern)}${caseless}`);
};

/** How each command reads, given where it applies (`where`) and whether sed is quiet (`-n`). */
const explainers: ReadonlyMap<Character, (command: SedCommand, where: Explanation, quiet: boolean) => Text> = new Map<Character, (command: SedCommand, where: Explanation, quiet: boolean) => Text>([
  ["p", (_, where, quiet) => (quiet ? `Prints ${where}.` : `Prints ${where} a second time.`)],
  ["d", (_, where) => `Deletes ${where}.`],
  [
    "s",
    (command, where) =>
      `Replaces ${matchesOf(command.flags, command.pattern)} with ${quoted(command.replacement)}, on ${where}` +
      `${command.flags?.includes("p") === true ? ", and prints the lines it changes" : ""}` +
      `${command.file === undefined ? "" : `, and writes the lines it changes to ${command.file}`}` +
      `${command.flags?.includes("e") === true ? ", then runs each changed line as a shell command" : ""}.`,
  ],
  ["y", (command, where) => `Changes each character of ${quoted(command.pattern)} to the one in the same place in ${quoted(command.replacement)}, on ${where}.`],
  ["a", (command, where) => `Adds the line ${quoted(command.text)} after ${where}.`],
  ["i", (command, where) => `Adds the line ${quoted(command.text)} before ${where}.`],
  ["c", (command, where) => `Replaces ${where} with the line ${quoted(command.text)}.`],
  ["q", (_, where) => `Stops after ${where}.`],
  ["Q", (_, where) => `Stops at ${where}, without printing it.`],
  ["=", (_, where) => `Prints the line number of ${where}.`],
  ["l", (_, where) => `Prints ${where}, showing characters that do not print.`],
  ["L", (_, where) => `Prints ${where}, showing characters that do not print.`],
  ["r", (command, where) => `Adds the contents of ${command.file ?? ""} after ${where}.`],
  ["R", (command, where) => `Adds the next line of ${command.file ?? ""} after ${where}.`],
  ["w", (command, where) => `Writes ${where} to ${command.file ?? ""}.`],
  ["W", (command, where) => `Writes the first line of ${where} to ${command.file ?? ""}.`],
  ["e", (command, where) => (command.text === undefined || command.text === "" ? `Runs ${where} as a shell command.` : `Runs ${quoted(command.text)} as a shell command, at ${where}.`)],
]);

/** One command, in plain English, as lines at `depth`. A block's commands sit one level deeper. */
const explainOne = (command: SedCommand, quiet: boolean, depth: number): ReadonlyArray<ExplanationLine> => {
  const where = describeAddresses(command, depth > 1);
  if (command.letter === "{") return [{ depth, text: said(`On ${where}:`) }, ...(command.block ?? []).flatMap((inner) => explainOne(inner, quiet, depth + 1))];
  const explainer = explainers.get(command.letter);
  return [{ depth, text: said(explainer === undefined ? `Uses \`${command.letter}\` on ${where}, to join, hold or branch between lines.` : explainer(command, where, quiet)) }];
};

/**
 * Returns what a `sed` call does, in plain English: what it reads (its `files`, or its input), each of
 * its scripts' commands, and what it prints or saves. `quiet` is `-n`; `inPlace` is `-i`.
 */
export const explain = (
  scripts: ReadonlyArray<ReadonlyArray<SedCommand>>,
  options: { readonly quiet: boolean; readonly inPlace: boolean; readonly files: ReadonlyArray<SedFile> },
): ReadonlyArray<ExplanationLine> => {
  const files = options.files.join(", ");
  const lead = said(options.inPlace ? `Edits ${files} in place:` : `Reads ${options.files.length === 0 ? "its input" : files}:`);
  const steps = scripts.flat().flatMap((command) => explainOne(command, options.quiet, 1));
  const output = options.quiet ? [] : [{ depth: 1, text: said(options.inPlace ? "Saves every line, after these changes." : "Prints every line, after these changes.") }];
  return [{ depth: 0, text: lead }, ...steps, ...output];
};
