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
export const ShellCommand = Schema.String.pipe(Schema.brand("agent-policy/ShellCommand"));
export type ShellCommand = typeof ShellCommand.Type;

/** A word of a command: as written, or its value with quotes and escapes removed. */
export const WordText = Schema.String.pipe(Schema.brand("agent-policy/WordText"));
export type WordText = typeof WordText.Type;

/** Why a command was not split. */
export const UnparsedReason = Schema.String.pipe(Schema.brand("agent-policy/UnparsedReason"));
export type UnparsedReason = typeof UnparsedReason.Type;

/** A word as written, and its value when it is a literal string: no expansion, tilde, or unquoted glob or brace characters. */
export const Word = Schema.Struct({ text: WordText, literal: Schema.optionalKey(WordText) });
export type Word = typeof Word.Type;

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
  /** The variables set by the command, as written (`NAME=value`). */
  assignments: Schema.Array(WordText),
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
