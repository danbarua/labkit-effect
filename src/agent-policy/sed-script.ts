/**
 * What a `sed` script does besides transforming text, read from the script itself: whether it runs
 * shell commands (`e`, or the `e` flag of `s`), the files it writes (`w`, `W`, the `w` flag of `s`),
 * and the files it reads (`r`, `R`). The permission policy judges a `sed` call by these
 * (`command-units.ts`).
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
 * A script with anything else, or that ends inside a command, is not understood: `analyse` returns
 * undefined, and the policy treats the call as code it cannot judge.
 */

import { Schema } from "effect";

/** A sed script, as written in a command. */
export const SedScript = Schema.String.pipe(Schema.brand("agent-policy/SedScript"));
export type SedScript = typeof SedScript.Type;

/** A file name that a script names. */
export const SedFile = Schema.String.pipe(Schema.brand("agent-policy/SedFile"));
export type SedFile = typeof SedFile.Type;

/** What a script does besides transforming text. */
export interface SedEffects {
  readonly executes: boolean;
  readonly writes: ReadonlyArray<SedFile>;
  readonly reads: ReadonlyArray<SedFile>;
}

const none: SedEffects = { executes: false, writes: [], reads: [] };
const merged = (one: SedEffects, other: SedEffects): SedEffects => ({
  executes: one.executes || other.executes,
  writes: [...one.writes, ...other.writes],
  reads: [...one.reads, ...other.reads],
});

type Read = { readonly at: number; readonly effects: SedEffects } | undefined;

/** One character of a script. */
type Character = SedScript[number];

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

/** Returns the index after the addresses at `at` (with their `I`/`M` flags, a range's `,` and a `!`), or -1. */
const pastAddresses = (script: SedScript, at: number): number => {
  const first = pastAddress(script, at);
  if (first === -1) return -1;
  const flagged = first > at ? first + (/^[IM]*/.exec(script.slice(first))?.[0].length ?? 0) : first;
  const range = script[skipBlanks(script, flagged)] === "," ? pastAddress(script, skipBlanks(script, skipBlanks(script, flagged) + 1)) : flagged;
  if (range === -1) return -1;
  const ranged = range + (/^[IM]*/.exec(script.slice(range))?.[0].length ?? 0);
  const negated = skipBlanks(script, ranged);
  return script[negated] === "!" ? skipBlanks(script, negated + 1) : negated;
};

/** Returns the index after a command's end: blanks, then `;`, a newline, `}` or the end. -1 when something else follows. */
const pastEnd = (script: SedScript, at: number): number => {
  const next = skipBlanks(script, at);
  const character = script[next];
  if (character === undefined || character === "}") return next;
  if (character === ";" || character === "\n") return next + 1;
  return character === "#" ? lineEnd(script, next) : -1;
};

/** The flags of `s` that it is known to take, besides a number. */
const substituteFlags = /^[gpiImMe0-9]*/;

/** Reads the `s` command whose delimiter is at `at`. */
const substitute = (script: SedScript, at: number): Read => {
  const delimiter = script[at];
  if (delimiter === undefined || delimiter === "\n" || delimiter === "\\") return undefined;
  const pattern = pastDelimited(script, at + 1, delimiter);
  const replacement = pattern === -1 ? -1 : pastDelimited(script, pattern, delimiter);
  if (replacement === -1) return undefined;
  const flags = substituteFlags.exec(script.slice(replacement))?.[0] ?? "";
  const afterFlags = replacement + flags.length;
  const executes = flags.includes("e");
  if (script[afterFlags] === "w") {
    const end = lineEnd(script, afterFlags + 1);
    const file = script.slice(skipBlanks(script, afterFlags + 1), end).trim();
    return file === "" ? undefined : { at: end, effects: { executes, writes: [SedFile.make(file)], reads: [] } };
  }
  const end = pastEnd(script, afterFlags);
  return end === -1 ? undefined : { at: end, effects: { executes, writes: [], reads: [] } };
};

/** Reads the commands from `at` to the end of the script, or to the `}` that closes a block when `inBlock`. */
const commands = (script: SedScript, at: number, effects: SedEffects, inBlock: boolean): Read => {
  const start = skipBlanks(script, at);
  const character = script[start];
  if (character === undefined) return inBlock ? undefined : { at: start, effects };
  if (character === "\n" || character === ";") return commands(script, start + 1, effects, inBlock);
  if (character === "#") return commands(script, lineEnd(script, start), effects, inBlock);
  if (character === "}") return inBlock ? { at: start + 1, effects } : undefined;
  const command = pastAddresses(script, start);
  if (command === -1) return undefined;
  const read = one(script, command);
  return read === undefined ? undefined : commands(script, read.at, merged(effects, read.effects), inBlock);
};

/** Reads one command whose letter is at `at`. */
const one = (script: SedScript, at: number): Read => {
  const letter = script[at];
  const after = at + 1;
  const toLineEnd = (effects: SedEffects): Read => ({ at: lineEnd(script, after), effects });
  const fileName = (): SedFile | undefined => {
    const name = script.slice(skipBlanks(script, after), lineEnd(script, after)).trim();
    return name === "" ? undefined : SedFile.make(name);
  };
  const ended = (effects: SedEffects, from: number): Read => {
    const end = pastEnd(script, from);
    return end === -1 ? undefined : { at: end, effects };
  };
  if (letter === undefined) return undefined;
  if (letter === "{") {
    const block = commands(script, after, none, true);
    if (block === undefined) return undefined;
    const end = pastEnd(script, block.at);
    return end === -1 ? undefined : { at: end, effects: block.effects };
  }
  if (letter === "s") return substitute(script, after);
  if (letter === "y") {
    const delimiter = script[after];
    if (delimiter === undefined || delimiter === "\n" || delimiter === "\\") return undefined;
    const source = pastDelimited(script, after + 1, delimiter);
    const target = source === -1 ? -1 : pastDelimited(script, source, delimiter);
    return target === -1 ? undefined : ended(none, target);
  }
  if (textCommands.has(letter)) return toLineEnd(none);
  if (branches.has(letter)) {
    // A label runs to `;`, `}` or the end of the line.
    const label = /^[^;\n}]*/.exec(script.slice(after))?.[0] ?? "";
    return ended(none, after + label.length);
  }
  if (letter === "r" || letter === "R" || letter === "w" || letter === "W") {
    const file = fileName();
    if (file === undefined) return undefined;
    return toLineEnd(letter === "r" || letter === "R" ? { executes: false, writes: [], reads: [file] } : { executes: false, writes: [file], reads: [] });
  }
  if (letter === "e") return toLineEnd({ executes: true, writes: [], reads: [] });
  if (numbered.has(letter)) return ended(none, after + (/^\s*\d*/.exec(script.slice(after))?.[0].length ?? 0));
  return plain.has(letter) ? ended(none, after) : undefined;
};

/** Commands whose text, label or version runs to the end of the line. */
const textCommands: ReadonlySet<Character> = new Set(["a", "i", "c", ":", "v"]);
/** Branches, which take a label. */
const branches: ReadonlySet<Character> = new Set(["b", "t", "T"]);
/** Commands that take an optional number. */
const numbered: ReadonlySet<Character> = new Set(["q", "Q", "l", "L"]);
/** Commands that take nothing. */
const plain: ReadonlySet<Character> = new Set(["=", "d", "D", "g", "G", "h", "H", "n", "N", "p", "P", "x", "z", "F"]);

/** Returns what `script` does besides transforming text; undefined when it is not understood. */
export const analyse = (script: SedScript): SedEffects | undefined => commands(script, 0, none, false)?.effects;
