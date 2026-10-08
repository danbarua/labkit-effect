/**
 * A shell command's segments: every simple command it would run, wherever it is written (a pipeline,
 * a `;` or `&&` list, a subshell, a function's body, a condition, a command or process
 * substitution), with its words, its redirects and where it runs. The host splits a command with the
 * Rust crate `native/bash-segments` (`agent-host/command-parser.ts`), in this form.
 *
 * A command that the parser cannot follow in full, or could not split at all (its module not built,
 * say), is `Unparsed`, with the reason. The permission policy asks about it.
 */

import { Schema } from "effect";

/** A shell command, as a tool's input gives it. */
export const ShellCommand = Schema.String.pipe(Schema.brand("agent-environment/ShellCommand"));
export type ShellCommand = typeof ShellCommand.Type;

/** A word of a command: as written, or its value with quotes and escapes removed. */
export const WordText = Schema.String.pipe(Schema.brand("agent-environment/WordText"));
export type WordText = typeof WordText.Type;

/** Why a command was not split. */
export const UnparsedReason = Schema.String.pipe(Schema.brand("agent-environment/UnparsedReason"));
export type UnparsedReason = typeof UnparsedReason.Type;

/**
 * What a parameter expansion does to the parameter's value: `value` (`$V`); a default (`${V:-w}`,
 * `${V-w}` when unset only), an assignment of one (`${V:=w}`, `${V=w}`), an alternative (`${V:+w}`,
 * `${V+w}`), an error (`${V:?w}`); its length (`${#V}`); a pattern removed from its end (`${V%p}`,
 * `${V%%p}`) or its start (`${V#p}`, `${V##p}`); or `other` (an indirection, an index, a substring, a
 * replacement, a case change, a transform).
 */
export const ParameterOp = Schema.Literals([
  "value",
  "default",
  "default_if_unset",
  "assign",
  "assign_if_unset",
  "alternative",
  "alternative_if_unset",
  "error",
  "length",
  "remove_suffix",
  "remove_longest_suffix",
  "remove_prefix",
  "remove_longest_prefix",
  "other",
]);
export type ParameterOp = typeof ParameterOp.Type;

/** Which folder a tilde names: the home folder (`~`), a user's (`~user`), the working folder (`~+`), the previous one (`~-`), or one of the stack (`~1`). */
export const TildeOf = Schema.Literals(["home", "user", "working", "previous", "stack"]);
export type TildeOf = typeof TildeOf.Type;

/**
 * A part of a word, as the shell expands it (`native/bash-segments`): text, with quotes and escapes
 * removed; a tilde; a parameter expansion, with what is done to its value and that operation's word
 * in parts, or its pattern as written; a command substitution, with the command as written (its
 * segments are reported with the command's own); or an arithmetic expansion. `quoted` when it is
 * inside quotes, so that the shell neither splits nor globs it.
 */
export type Part =
  | { readonly kind: "text"; readonly value: WordText; readonly quoted?: boolean }
  | { readonly kind: "tilde"; readonly of: TildeOf; readonly user?: WordText }
  | { readonly kind: "parameter"; readonly name: WordText; readonly op: ParameterOp; readonly word?: ReadonlyArray<Part>; readonly pattern?: WordText; readonly quoted?: boolean }
  | { readonly kind: "command"; readonly command: ShellCommand; readonly quoted?: boolean }
  | { readonly kind: "arithmetic"; readonly expression: WordText; readonly quoted?: boolean };

/** A part as the parser writes it, before its strings are branded. */
export type PartEncoded =
  | { readonly kind: "text"; readonly value: string; readonly quoted?: boolean }
  | { readonly kind: "tilde"; readonly of: TildeOf; readonly user?: string }
  | { readonly kind: "parameter"; readonly name: string; readonly op: ParameterOp; readonly word?: ReadonlyArray<PartEncoded>; readonly pattern?: string; readonly quoted?: boolean }
  | { readonly kind: "command"; readonly command: string; readonly quoted?: boolean }
  | { readonly kind: "arithmetic"; readonly expression: string; readonly quoted?: boolean };

const PartRef = Schema.suspend((): Schema.Codec<Part, PartEncoded> => Part);

export const Part = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), value: WordText, quoted: Schema.optionalKey(Schema.Boolean) }),
  Schema.Struct({ kind: Schema.Literal("tilde"), of: TildeOf, user: Schema.optionalKey(WordText) }),
  Schema.Struct({
    kind: Schema.Literal("parameter"),
    name: WordText,
    op: ParameterOp,
    word: Schema.optionalKey(Schema.Array(PartRef)),
    pattern: Schema.optionalKey(WordText),
    quoted: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ kind: Schema.Literal("command"), command: ShellCommand, quoted: Schema.optionalKey(Schema.Boolean) }),
  Schema.Struct({ kind: Schema.Literal("arithmetic"), expression: WordText, quoted: Schema.optionalKey(Schema.Boolean) }),
]);

/**
 * A word as written; its value when it is a literal string (no expansion, tilde, or unquoted glob or
 * brace characters); and otherwise its parts, in order.
 */
export const Word = Schema.Struct({ text: WordText, literal: Schema.optionalKey(WordText), parts: Schema.optionalKey(Schema.Array(Part)) });
export type Word = typeof Word.Type;

/** A variable a command sets: its name, its value as a word (absent for an array, or a loop over the positional parameters), and whether the value is appended (`NAME+=value`). */
export const Assigned = Schema.Struct({ name: WordText, value: Schema.optionalKey(Word), append: Schema.optionalKey(Schema.Boolean) });
export type Assigned = typeof Assigned.Type;

/** A redirect's operator: `<<` is a here-document and `<<<` a here-string. */
export const RedirectOp = Schema.Literals(["<", ">", ">>", "<>", ">|", "<&", ">&", "&>", "&>>", "<<", "<<<"]);
export type RedirectOp = typeof RedirectOp.Type;

/** A redirect: its operator, the descriptor it names, its target (none for a here-document, a here-string or a process substitution), and the text a here-document or here-string gives as input. */
export const Redirect = Schema.Struct({
  op: RedirectOp,
  fd: Schema.optionalKey(Schema.Int),
  target: Schema.optionalKey(Word),
  body: Schema.optionalKey(WordText),
  /** Whether the shell expands the body before giving it (`$x`): a here-document whose delimiter is not quoted, or a here-string that is not a literal word. */
  expands: Schema.optionalKey(Schema.Boolean),
});
export type Redirect = typeof Redirect.Type;

export const Segment = Schema.Struct({
  kind: Schema.Literals(["simple", "function_definition", "test", "arithmetic"]),
  /** The program and its arguments. Empty for a command that only assigns variables. */
  words: Schema.Array(Word),
  /** The variables the command sets: for it alone (`NAME=value cmd`), or in the shell when it has no words; for a `for` loop, one for each value its variable takes. */
  assignments: Schema.Array(Assigned),
  /** Its own redirects, then those of the compound commands it is inside. */
  redirects: Schema.Array(Redirect),
  /** Whether its standard input is text written in the command: a here-document or a here-string. */
  fed_text: Schema.Boolean,
  context: Schema.Literals(["command", "subshell", "function_body", "command_substitution", "process_substitution"]),
  /** Its place in a pipeline of two commands or more (`a | b`): which pipeline of the command, from 0; its position, from 0; and how many commands the pipeline has. */
  pipe: Schema.optionalKey(Schema.Struct({ pipeline: Schema.Int, position: Schema.Int, of: Schema.Int })),
});
export type Segment = typeof Segment.Type;

export const Segments = Schema.Union([
  Schema.TaggedStruct("Parsed", { segments: Schema.Array(Segment) }),
  Schema.TaggedStruct("Unparsed", { reason: UnparsedReason }),
]);
export type Segments = typeof Segments.Type;

/** A function that splits a command into its segments: the host's parser, or a test's stand-in. */
export type SegmentsOf = (command: ShellCommand) => Segments;
