/** The REPL's input prompt: what each key does to the text typed so far. */

import { expect } from "bun:test";
import { Effect, Option, Terminal } from "effect";
import { test } from "../../../tests/support/test.ts";
import { hinted, keyed, rendered, rowsOf, type Typed } from "./multiline.ts";

const key = (name: string, input?: string, modifiers: { meta?: boolean; ctrl?: boolean } = {}): Terminal.UserInput => ({
  input: input === undefined ? Option.none() : Option.some(input),
  key: { name, ctrl: modifiers.ctrl ?? false, meta: modifiers.meta ?? false, shift: false },
});

/** Returns the text after `keys`, and the last key's action. */
const after = (keys: ReadonlyArray<Terminal.UserInput>) =>
  keys.reduce<{ state: Typed; last: string; submitted?: string }>(
    (so, each) => {
      const action = keyed(so.state, each);
      if (action._tag === "NextFrame") return { state: action.state, last: action._tag };
      return action._tag === "Submit" ? { state: so.state, last: action._tag, submitted: action.value } : { state: so.state, last: action._tag };
    },
    { state: { text: "", pasting: false, drawn: "" }, last: "" },
  );

test("Enter submits; Alt+Enter and a line feed (Ctrl+J) are a new line", () => {
  const typed = after([key("a", "a"), key("return", undefined, { meta: true }), key("b", "b"), key("enter", "\n"), key("c", "c"), key("return", "\r")]);
  expect(typed.submitted).toBe("a\nb\nc");
});

test("a paste keeps its line breaks and does not submit; Enter after it does", () => {
  const paste = [key("paste-start"), key("x", "x"), key("return", "\r"), key("y", "y"), key("enter", "\n"), key("paste-end")];
  expect(after(paste)).toMatchObject({ state: { text: "x\ny\n", pasting: false }, last: "NextFrame" });
  expect(after([...paste, key("return", "\r")]).submitted).toBe("x\ny\n");
});

test("Backspace deletes the last character; a key that produces no text inserts nothing", () => {
  expect(after([key("a", "a"), key("b", "b"), key("backspace", "\x7f"), key("d", "d")]).state.text).toBe("ad");
  expect(after([key("a", "a"), key("up"), key("c", "\x03", { ctrl: true })])).toMatchObject({ state: { text: "a" }, last: "Beep" });
});

test("a line wider than the terminal counts as the number of rows it wraps onto", () => {
  // The prompt's lead is 8 columns wide, and so is the indent of the lines after the first.
  expect(rowsOf("", 80)).toBe(1);
  expect(rowsOf("x".repeat(72), 80)).toBe(1);
  expect(rowsOf("x".repeat(73), 80)).toBe(2);
  expect(rowsOf(`short\n${"x".repeat(200)}\nend`, 80)).toBe(1 + 3 + 1);
  // A terminal with no width (a pseudo-terminal with no size) wraps nothing.
  expect(rowsOf(`short\n${"x".repeat(200)}\nend`, 0)).toBe(3);
});

test("during a paste the screen is not redrawn; the pasted text appears when the paste ends", () => {
  const pasting = after([key("a", "a"), key("paste-start"), key("x", "x"), key("return", "\r"), key("y", "y")]);
  expect(pasting.state).toEqual({ text: "ax\ny", pasting: true, drawn: "a" });
  expect(after([key("a", "a"), key("paste-start"), key("x", "x"), key("paste-end")]).state).toEqual({ text: "ax", pasting: false, drawn: "ax" });
});

test("Tab completes to the longest prefix all completions share, and beeps when there is nothing to add", () => {
  const complete = (text: string) => ["/model ", "/more", "/settings "].filter((each) => each.startsWith(text));
  const tab = (text: string) => keyed({ text, pasting: false, drawn: text }, key("tab", "\t"), complete);
  expect(tab("/")).toEqual({ _tag: "Beep" });
  expect(tab("/m")).toMatchObject({ _tag: "NextFrame", state: { text: "/mo" } });
  expect(tab("/s")).toMatchObject({ _tag: "NextFrame", state: { text: "/settings " } });
  expect(tab("hello")).toEqual({ _tag: "Beep" });
});

test("the completion hint shows each completion's last word, truncated to fit the row", () => {
  const complete = (text: string) => ["/settings effort=low", "/settings effort=medium", "/settings effort=high"].filter((each) => each.startsWith(text));
  expect(hinted("/settings eff", complete, 60)).toBe("  effort=low  effort=medium  effort=high");
  expect(hinted("/settings eff", complete, 20)).toBe("  effort=low  effor…");
  expect(hinted("/settings eff", complete, 5)).toBe("");
  expect(hinted("/settings effort=low", complete, 60)).toBe("");
  expect(hinted("hello", complete, 60)).toBe("");
  // A completion that adds only the space before the next word shows nothing.
  expect(hinted("/settings", () => ["/settings "], 60)).toBe("");
});

test("a beep rings the terminal bell, except during a paste", () => {
  const typed: Typed = { text: "ab", pasting: false, drawn: "ab" };
  // Neither reads the terminal; it is provided only to satisfy the type.
  const draw = (state: Typed, action: Parameters<typeof rendered>[1]) =>
    Effect.runSync(rendered(state, action, () => []).pipe(Effect.provideService(Terminal.Terminal, {} as Terminal.Terminal)));
  expect(draw(typed, { _tag: "Beep" })).toBe("\x07");
  expect(draw({ ...typed, pasting: true }, { _tag: "NextFrame", state: { ...typed, pasting: true } })).toBe("");
});
