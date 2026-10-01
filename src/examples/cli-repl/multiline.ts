/**
 * The REPL's input prompt: text of more than one line. Enter submits. A new line is Alt+Enter
 * (Option+Enter), or Ctrl+J; pasted text keeps its line breaks, and is not submitted by them.
 *
 * - A paste is told from typing by bracketed paste mode, which `bracketedPaste` turns on for as long
 *   as its scope lasts: the terminal then marks where a paste starts and ends.
 * - Shift+Enter is a new line only where the terminal is set to send a line feed (`\n`) or
 *   Escape then Enter for it (iTerm2, VS Code, Ghostty and others can be). By default a terminal sends
 *   the same byte for Enter and Shift+Enter, and Effect's `Terminal` does not name the key that the
 *   kitty keyboard protocol sends for it.
 * - Editing is at the end of the text: typing adds, Backspace removes. A line wider than the terminal
 *   is not counted as two when the frame is redrawn.
 */

import { Effect, Option, Terminal } from "effect";
import { Prompt } from "effect/cli";

export interface Typed {
  readonly text: string;
  /** Between the terminal's marks of a paste's start and end. */
  readonly pasting: boolean;
}

const lead = "? You › ";
const indent = " ".repeat(lead.length);

/** Erases the frame drawn for `text`, leaving the cursor at the start of its first line. */
const erased = (text: string): string => `\r\x1b[2K${"\x1b[1A\x1b[2K".repeat(text.split("\n").length - 1)}`;

/** Whether `text` starts with a control character: a key that types nothing. */
const isControl = (text: string): boolean => {
  const code = text.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
};

/** What a key, or a piece of a paste, does to what is typed so far. */
export function keyed(state: Typed, input: Terminal.UserInput): Prompt.Action<Typed, string> {
  const next = (changed: Partial<Typed>): Prompt.Action<Typed, string> => ({ _tag: "NextFrame", state: { ...state, ...changed } });
  const { name, ctrl, meta } = input.key;
  if (name === "paste-start") return next({ pasting: true });
  if (name === "paste-end") return next({ pasting: false });
  // A line feed (Ctrl+J, or a terminal's Shift+Enter), Alt+Enter, or a line break in a paste.
  if (name === "enter" || (name === "return" && (meta || state.pasting))) return next({ text: `${state.text}\n` });
  if (name === "return") return { _tag: "Submit", value: state.text };
  if (name === "backspace") return next({ text: state.text.slice(0, -1) });
  const typed = Option.getOrUndefined(input.input);
  if (typed !== undefined && !ctrl && !meta && !isControl(typed)) return next({ text: state.text + typed });
  return { _tag: "Beep" };
}

export const Multiline: Prompt.Prompt<string> = Prompt.Custom<Typed, string>(
  { text: "", pasting: false },
  {
    render: (state, action) =>
      Effect.succeed(action._tag === "Submit" ? `✔ You … ${action.value.split("\n").join(`\n${indent}`)}\n` : lead + state.text.split("\n").join(`\n${indent}`)),
    clear: (state) => Effect.succeed(erased(state.text)),
    process: (input, state) => Effect.succeed(keyed(state, input)),
  },
);

/** Bracketed paste mode, on for as long as the scope lasts. */
export const bracketedPaste = Effect.gen(function* () {
  const terminal = yield* Terminal.Terminal;
  yield* Effect.acquireRelease(Effect.orDie(terminal.display("\x1b[?2004h")), () => Effect.orDie(terminal.display("\x1b[?2004l")));
});
