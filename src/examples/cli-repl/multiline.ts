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
 * - Editing is at the end of the text: typing adds, Backspace removes.
 * - Tab completes: the prompt is given a function from the text typed to the texts it could become.
 *   Tab makes the text what they all begin with; what each would add to the last word is shown
 *   after the text, dimmed, as far as the row has room.
 * - The frame is redrawn after each key: the rows it took are erased, a line wider than the terminal
 *   counted as the rows it wraps to. A paste is drawn once, when it ends.
 */

import { Effect, Option, Terminal } from "effect";
import { Prompt } from "effect/cli";

export interface Typed {
  readonly text: string;
  /** Between the terminal's marks of a paste's start and end. */
  readonly pasting: boolean;
  /** The text of the frame on the screen: `text`, except during a paste, which is drawn when it ends. */
  readonly drawn: string;
}

const lead = "? You › ";
const indent = " ".repeat(lead.length);

const frame = (text: string): string => lead + text.split("\n").join(`\n${indent}`);

const reset = "\x1b[0m";
const bold = "\x1b[1m";

/**
 * The frame for `text` in the colours and symbols of Effect's prompts (`Prompt.Theme`): while it is
 * typed, or once it is submitted. It takes the same columns as `frame`, whose rows are counted.
 */
const painted = (text: string, submitted: boolean) =>
  Effect.map(Prompt.Theme, (theme) => {
    const lines = text.split("\n").join(`\n${indent}`);
    return submitted
      ? `${theme.successColor}${theme.tick}${reset} ${bold}You${reset} ${theme.mutedColor}${theme.ellipsis}${reset} ${theme.submittedColor}${lines}${reset}`
      : `${theme.primaryColor}${theme.prefix}${reset} ${bold}You${reset} ${theme.mutedColor}${theme.pointerSmall}${reset} ${lines}`;
  });

/** How many rows of a terminal `columns` wide the frame for `text` takes: a line wider than the terminal wraps. */
export const rowsOf = (text: string, columns: number): number =>
  frame(text)
    .split("\n")
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(Bun.stringWidth(line) / columns)), 0);

/** Erases the frame drawn for `text`, leaving the cursor at the start of its first row. */
const erased = (text: string, columns: number): string => `\r\x1b[2K${"\x1b[1A\x1b[2K".repeat(rowsOf(text, columns) - 1)}`;

/** Whether `text` starts with a control character: a key that types nothing. */
const isControl = (text: string): boolean => {
  const code = text.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
};

/** The texts that `text` could become. */
export type Complete = (text: string) => ReadonlyArray<string>;

const nothing: Complete = () => [];

/** What every one of `texts` begins with. */
const sharedStart = (texts: ReadonlyArray<string>): string =>
  texts.reduce((shared, text) => {
    let length = 0;
    while (length < shared.length && shared[length] === text[length]) length++;
    return shared.slice(0, length);
  });

/**
 * What is shown after `text` of the texts it could become: each one's last word, in a row with
 * `room` columns left; nothing when there are none, or no room.
 */
export function hinted(text: string, complete: Complete, room: number): string {
  const from = text.lastIndexOf(" ") + 1;
  const words = complete(text).map((each) => each.slice(from).trimEnd()).filter((word) => word !== text.slice(from));
  if (words.length === 0) return "";
  const all = `  ${words.join("  ")}`;
  if (Bun.stringWidth(all) <= room) return all;
  return room < 8 ? "" : `${all.slice(0, room - 1)}…`;
}

/** What a key, or a piece of a paste, does to what is typed so far. */
export function keyed(state: Typed, input: Terminal.UserInput, complete: Complete = nothing): Prompt.Action<Typed, string> {
  const next = (changed: Partial<Typed>): Prompt.Action<Typed, string> => {
    const to = { ...state, ...changed };
    return { _tag: "NextFrame", state: { ...to, drawn: to.pasting ? state.drawn : to.text } };
  };
  const { name, ctrl, meta } = input.key;
  if (name === "paste-start") return next({ pasting: true });
  if (name === "paste-end") return next({ pasting: false });
  // A line feed (Ctrl+J, or a terminal's Shift+Enter), Alt+Enter, or a line break in a paste.
  if (name === "enter" || (name === "return" && (meta || state.pasting))) return next({ text: `${state.text}\n` });
  if (name === "return") return { _tag: "Submit", value: state.text };
  if (name === "backspace") return next({ text: state.text.slice(0, -1) });
  if (name === "tab") {
    const could = complete(state.text);
    const shared = could.length === 0 ? state.text : sharedStart(could);
    return shared.length > state.text.length ? next({ text: shared }) : { _tag: "Beep" };
  }
  const typed = Option.getOrUndefined(input.input);
  if (typed !== undefined && !ctrl && !meta && !isControl(typed)) return next({ text: state.text + typed });
  return { _tag: "Beep" };
}

/** The frame for `text`, and after it the hint, dimmed; the cursor is left at the end of the text. */
const drawn = (text: string, complete: Complete) =>
  Effect.gen(function* () {
    const columns = yield* (yield* Terminal.Terminal).columns;
    const last = frame(text).split("\n").at(-1) ?? "";
    const hint = hinted(text, complete, columns - 1 - (Bun.stringWidth(last) % columns));
    const typed = yield* painted(text, false);
    return hint === "" ? typed : `${typed}\x1b7\x1b[2m${hint}${reset}\x1b8`;
  });

export const Multiline = (complete: Complete = nothing): Prompt.Prompt<string> =>
  Prompt.Custom<Typed, string>(
    { text: "", pasting: false, drawn: "" },
    {
      // During a paste nothing is drawn: the frame from before it stays, and the whole paste is drawn when it ends.
      render: (state, action) =>
        action._tag === "Submit"
          ? Effect.map(painted(action.value, true), (line) => `${line}\n`)
          : action._tag === "Beep"
            ? Effect.succeed("\x07")
            : state.pasting
              ? Effect.succeed("")
              : drawn(state.text, complete),
      clear: (state, action) =>
        action._tag === "NextFrame" && action.state.pasting
          ? Effect.succeed("")
          : Effect.gen(function* () {
              return erased(state.drawn, yield* (yield* Terminal.Terminal).columns);
            }),
      process: (input, state) => Effect.succeed(keyed(state, input, complete)),
    },
  );

/** Bracketed paste mode, on for as long as the scope lasts. */
export const bracketedPaste = Effect.gen(function* () {
  const terminal = yield* Terminal.Terminal;
  yield* Effect.acquireRelease(Effect.orDie(terminal.display("\x1b[?2004h")), () => Effect.orDie(terminal.display("\x1b[?2004l")));
});
