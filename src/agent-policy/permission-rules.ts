/**
 * The permission policy's rules (`permissions.ts`), as a configuration writes them in
 * `plugins.permissions.allow` and `deny`:
 *
 * | Rule | Names |
 * | --- | --- |
 * | `<tool>` | every call to the tool |
 * | `<tool>(<words>)` | a command tool's program that is exactly these words |
 * | `<tool>(<words>:*)` | a command tool's program whose words start with these |
 *
 * `command` in place of a tool's name names every command tool (`commandTools`). Words are separated
 * by spaces, so a rule cannot name a word that has a space in it.
 *
 * A rule with words is matched against each program a command runs (`command-units.ts`), past its
 * wrappers: a word of the program that is not literal matches no word of a rule. An allow rule
 * compares the program's name as written, so `ls:*` does not allow `./ls`; a deny rule compares the
 * last part of its path, so `rm:*` denies `/bin/rm` too.
 *
 * The read-only programs (`readOnly`) are prefixes of the same kind, without a tool: each allows,
 * for every command tool, a program whose words start with it and whose name has no path.
 */

import { Schema } from "effect";
import { ToolName } from "../agent-machine/names.ts";
import { WordText } from "./command-segments.ts";
import type { Unit } from "./command-units.ts";

/** A rule: `<tool>`, `<tool>(<words>)` or `<tool>(<words>:*)`. */
export const PermissionRule = Schema.String.pipe(
  Schema.brand("agent-policy/PermissionRule"),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_.-]+(\([^()\s](?:[^()]*[^()\s])?\))?$/u, { message: "Expected <tool>, <tool>(<words>) or <tool>(<words>:*)" })),
);
export type PermissionRule = typeof PermissionRule.Type;

/** A read-only program: the words its commands start with (`git log`). */
export const ReadOnlyPrefix = Schema.String.pipe(
  Schema.brand("agent-policy/ReadOnlyPrefix"),
  Schema.check(Schema.isPattern(/^\S+( \S+)*$/u, { message: "Expected words separated by single spaces" })),
);
export type ReadOnlyPrefix = typeof ReadOnlyPrefix.Type;

/** A rule, read. */
export interface ParsedRule {
  readonly rule: PermissionRule;
  /** The tool it names; `command` for every command tool. */
  readonly tool: ToolName;
  /** The words it names, if any. */
  readonly words: ReadonlyArray<WordText> | undefined;
  /** Whether its words are a prefix (`:*`) rather than the whole program. */
  readonly prefix: boolean;
}

/** The name that stands for every command tool in a rule. */
export const everyCommandTool = ToolName.make("command");

/** Returns `rule` read. */
export const parseRule = (rule: PermissionRule): ParsedRule => {
  const open = rule.indexOf("(");
  if (open === -1) return { rule, tool: ToolName.make(rule), words: undefined, prefix: false };
  const inside = rule.slice(open + 1, -1);
  const prefix = inside.endsWith(":*");
  const words = (prefix ? inside.slice(0, -2) : inside).split(" ").filter((word) => word !== "");
  return { rule, tool: ToolName.make(rule.slice(0, open)), words: words.map((word) => WordText.make(word)), prefix };
};

/** Whether `rule` names `tool`, a command tool when `isCommandTool`. */
export const namesTool = (rule: ParsedRule, tool: ToolName, isCommandTool: boolean): boolean => rule.tool === tool || (isCommandTool && rule.tool === everyCommandTool);

const lastPart = (word: WordText): WordText => WordText.make(word.slice(word.lastIndexOf("/") + 1));

/**
 * Whether `words` (a rule's or a read-only program's) name `unit`'s program: as a prefix, or exactly.
 * With `byBasename`, the program's name is compared by the last part of its path.
 */
export const namesProgram = (words: ReadonlyArray<WordText>, prefix: boolean, unit: Unit, byBasename: boolean): boolean => {
  const literal = unit.words.map((word) => word.literal);
  if (words.length === 0 || literal.length < words.length || (!prefix && literal.length !== words.length)) return false;
  return words.every((word, at) => {
    const own = literal[at];
    if (own === undefined) return false;
    return at === 0 && byBasename ? lastPart(own) === lastPart(word) : own === word;
  });
};

/** Whether `rule`, which has words, names `unit`'s program; deny rules compare the program by the last part of its path. */
export const ruleNamesProgram = (rule: ParsedRule, unit: Unit, deny: boolean): boolean =>
  rule.words !== undefined && namesProgram(rule.words, rule.prefix, unit, deny);

/** Whether a read-only prefix names `unit`'s program: its words start with the prefix and its name has no path. */
export const readOnlyNames = (prefix: ReadOnlyPrefix, unit: Unit): boolean =>
  unit.words[0]?.literal?.includes("/") !== true && namesProgram(prefix.split(" ").map((word) => WordText.make(word)), true, unit, false);

/** The read-only programs when the configuration names none: they print, search or show, and change nothing. */
export const defaultReadOnly: ReadonlyArray<ReadOnlyPrefix> = [
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "grep", "rg", "which", "cd", "git status", "git log", "git diff", "git show",
].map((prefix) => ReadOnlyPrefix.make(prefix));
