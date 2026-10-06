/**
 * The REPL's input prompt, which takes text of more than one line. Enter submits. Alt+Enter
 * (Option+Enter) or Ctrl+J inserts a new line; pasted text keeps its line breaks without submitting.
 *
 * - Pastes are told apart from typing by bracketed paste mode, which `bracketedPaste` turns on for
 *   its scope: the terminal then marks where a paste starts and ends.
 * - Shift+Enter inserts a new line only in a terminal configured to send a line feed (`\n`) or
 *   Escape then Enter for it (iTerm2, VS Code, Ghostty and others can be). By default terminals send
 *   the same byte for Enter and Shift+Enter, and Effect's `Terminal` does not recognise the kitty
 *   keyboard protocol's code for it.
 * - Editing happens at the end of the text: typing appends, Backspace deletes.
 * - Tab completes, using a function from the typed text to its possible completions: it extends the
 *   text to their longest shared prefix. The rest of each completion's last word is shown dimmed
 *   after the text, as far as the row has room.
 * - A key binding (Option+T) runs its action, except during a paste, and its note is shown dimmed
 *   after the text, in place of the completions, until the next key.
 * - The prompt is redrawn after each key: its previous rows are erased, counting a line wider than
 *   the terminal as the rows it wraps onto. A paste is drawn once, when it ends.
 */

import { Effect, Option, Terminal } from "effect";
import { Prompt } from "effect/cli";

export interface Typed {
  readonly text: string;
  /** Whether a paste is in progress: between the terminal's paste-start and paste-end marks. */
  readonly pasting: boolean;
  /** The text currently drawn: `text`, except during a paste, which is drawn when it ends. */
  readonly drawn: string;
  /** A key binding's note, shown dimmed after the text in place of the completions until the next key. */
  readonly note?: string;
}

/** A key that runs an action instead of typing (Option+T), except during a paste: `run` performs it and returns a note. */
export interface KeyBinding {
  readonly matches: (input: Terminal.UserInput) => boolean;
  readonly run: Effect.Effect<string>;
}

const lead = "? You › ";
const indent = " ".repeat(lead.length);

const frame = (text: string): string => lead + text.split("\n").join(`\n${indent}`);

const reset = "\x1b[0m";
const bold = "\x1b[1m";

/**
 * Renders the prompt for `text` in the colours and symbols of Effect's prompts (`Prompt.Theme`),
 * while typing or once submitted. It takes the same columns as `frame`, which is used to count rows.
 */
const painted = (text: string, submitted: boolean) =>
  Effect.map(Prompt.Theme, (theme) => {
    const lines = text.split("\n").join(`\n${indent}`);
    return submitted
      ? `${theme.successColor}${theme.tick}${reset} ${bold}You${reset} ${theme.mutedColor}${theme.ellipsis}${reset} ${theme.submittedColor}${lines}${reset}`
      : `${theme.primaryColor}${theme.prefix}${reset} ${bold}You${reset} ${theme.mutedColor}${theme.pointerSmall}${reset} ${lines}`;
  });

/**
 * Returns the rows the prompt for `text` takes in a terminal `columns` wide, counting wrapped lines. A
 * terminal reporting no columns (a pseudo-terminal with no size) is treated as never wrapping.
 */
export const rowsOf = (text: string, columns: number): number =>
  frame(text)
    .split("\n")
    .reduce((rows, line) => rows + (columns > 0 ? Math.max(1, Math.ceil(Bun.stringWidth(line) / columns)) : 1), 0);

/** Erases the prompt drawn for `text`, leaving the cursor at the start of its first row. */
const erased = (text: string, columns: number): string => `\r\x1b[2K${"\x1b[1A\x1b[2K".repeat(rowsOf(text, columns) - 1)}`;

/** Whether `text` starts with a control character, which types nothing. */
const isControl = (text: string): boolean => {
  const code = text.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
};

/** A function from the typed text to its possible completions. */
export type Complete = (text: string) => ReadonlyArray<string>;

const nothing: Complete = () => [];

/** Returns the longest prefix all of `texts` share. */
const sharedStart = (texts: ReadonlyArray<string>): string =>
  texts.reduce((shared, text) => {
    // By UTF-16 code unit, as the text is indexed.
    const differs = Array.from({ length: shared.length }, (_, at) => at).find((at) => shared[at] !== text[at]);
    return differs === undefined ? shared : shared.slice(0, differs);
  });

/**
 * Returns the completion hint shown after `text`: each completion's last word, cut to the `room`
 * columns left in the row; empty when there are no completions or no room.
 */
export function hinted(text: string, complete: Complete, room: number): string {
  const from = text.lastIndexOf(" ") + 1;
  const words = complete(text).map((each) => each.slice(from).trimEnd()).filter((word) => word !== text.slice(from));
  if (words.length === 0) return "";
  const all = `  ${words.join("  ")}`;
  if (Bun.stringWidth(all) <= room) return all;
  return room < 8 ? "" : `${all.slice(0, room - 1)}…`;
}

/** Returns the effect of a key, or a piece of a paste, on the text typed so far. */
export function keyed(state: Typed, input: Terminal.UserInput, complete: Complete = nothing): Prompt.Action<Typed, string> {
  const next = (changed: Partial<Typed>): Prompt.Action<Typed, string> => {
    // A note is shown until the next key.
    const { note: _, ...before } = state;
    const to = { ...before, ...changed };
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

/** Returns `note` after two spaces, cut to `room` columns; empty when there is no room. */
const noted = (note: string, room: number): string => {
  const all = `  ${note}`;
  if (Bun.stringWidth(all) <= room) return all;
  return room < 8 ? "" : `${all.slice(0, room - 1)}…`;
};

/** Renders the prompt for `text`, followed by the note or else the completions, dimmed, with the cursor left at the end of the text. */
const drawn = (text: string, complete: Complete, note: string | undefined) =>
  Effect.gen(function* () {
    const columns = yield* (yield* Terminal.Terminal).columns;
    const last = frame(text).split("\n").at(-1) ?? "";
    const room = columns - 1 - (Bun.stringWidth(last) % columns);
    const hint = note === undefined ? hinted(text, complete, room) : noted(note, room);
    const typed = yield* painted(text, false);
    return hint === "" ? typed : `${typed}\x1b7\x1b[2m${hint}${reset}\x1b8`;
  });

/** Returns what to draw for `action`. During a paste nothing is drawn; the whole paste is drawn when it ends. */
export const rendered = (state: Typed, action: Prompt.Action<Typed, string>, complete: Complete) => {
  switch (action._tag) {
    case "Submit":
      return Effect.map(painted(action.value, true), (line) => `${line}\n`);
    case "Beep":
      return Effect.succeed("\x07");
    case "NextFrame":
      return state.pasting ? Effect.succeed("") : drawn(state.text, complete, state.note);
    default:
      return action satisfies never;
  }
};

export const Multiline = (complete: Complete = nothing, bindings: ReadonlyArray<KeyBinding> = []): Prompt.Prompt<string> =>
  Prompt.Custom<Typed, string>(
    { text: "", pasting: false, drawn: "" },
    {
      render: (state, action) => rendered(state, action, complete),
      clear: (state, action) =>
        action._tag === "NextFrame" && action.state.pasting
          ? Effect.succeed("")
          : Effect.gen(function* () {
              return erased(state.drawn, yield* (yield* Terminal.Terminal).columns);
            }),
      process: (input, state) => {
        const bound = state.pasting ? undefined : bindings.find((binding) => binding.matches(input));
        return bound === undefined ? Effect.succeed(keyed(state, input, complete)) : Effect.map(bound.run, (note): Prompt.Action<Typed, string> => ({ _tag: "NextFrame", state: { ...state, note } }));
      },
    },
  );

/** Bracketed paste mode, on for as long as the scope lasts. */
export const bracketedPaste = Effect.gen(function* () {
  const terminal = yield* Terminal.Terminal;
  yield* Effect.acquireRelease(Effect.orDie(terminal.display("\x1b[?2004h")), () => Effect.orDie(terminal.display("\x1b[?2004l")));
});
