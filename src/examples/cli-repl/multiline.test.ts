/** The REPL's input prompt: what each key does to the text typed so far. */

import { expect } from "bun:test";
import { Option, type Terminal } from "effect";
import { test } from "../../../tests/support/test.ts";
import { hinted, keyed, rowsOf, type Typed } from "./multiline.ts";

const key = (name: string, input?: string, modifiers: { meta?: boolean; ctrl?: boolean } = {}): Terminal.UserInput => ({
  input: input === undefined ? Option.none() : Option.some(input),
  key: { name, ctrl: modifiers.ctrl ?? false, meta: modifiers.meta ?? false, shift: false },
});

/** The text after `keys`, and what the last key did. */
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

test("Backspace removes the last character; a key with no text is not typed", () => {
  expect(after([key("a", "a"), key("b", "b"), key("backspace", "\x7f"), key("d", "d")]).state.text).toBe("ad");
  expect(after([key("a", "a"), key("up"), key("c", "\x03", { ctrl: true })])).toMatchObject({ state: { text: "a" }, last: "Beep" });
});

test("the frame's rows count a line wider than the terminal as the rows it wraps to", () => {
  // The prompt's lead is 8 columns wide, and so is the indent of the lines after the first.
  expect(rowsOf("", 80)).toBe(1);
  expect(rowsOf("x".repeat(72), 80)).toBe(1);
  expect(rowsOf("x".repeat(73), 80)).toBe(2);
  expect(rowsOf(`short\n${"x".repeat(200)}\nend`, 80)).toBe(1 + 3 + 1);
});

test("during a paste the frame on the screen stays as it was, and the paste is drawn when it ends", () => {
  const pasting = after([key("a", "a"), key("paste-start"), key("x", "x"), key("return", "\r"), key("y", "y")]);
  expect(pasting.state).toEqual({ text: "ax\ny", pasting: true, drawn: "a" });
  expect(after([key("a", "a"), key("paste-start"), key("x", "x"), key("paste-end")]).state).toEqual({ text: "ax", pasting: false, drawn: "ax" });
});

test("Tab makes the text what every completion begins with; with nothing to add it types nothing", () => {
  const complete = (text: string) => ["/model ", "/more", "/settings "].filter((each) => each.startsWith(text));
  const tab = (text: string) => keyed({ text, pasting: false, drawn: text }, key("tab", "\t"), complete);
  expect(tab("/")).toEqual({ _tag: "Beep" });
  expect(tab("/m")).toMatchObject({ _tag: "NextFrame", state: { text: "/mo" } });
  expect(tab("/s")).toMatchObject({ _tag: "NextFrame", state: { text: "/settings " } });
  expect(tab("hello")).toEqual({ _tag: "Beep" });
});

test("the hint is each completion's last word, cut to the room the row has", () => {
  const complete = (text: string) => ["/settings effort=low", "/settings effort=medium", "/settings effort=high"].filter((each) => each.startsWith(text));
  expect(hinted("/settings eff", complete, 60)).toBe("  effort=low  effort=medium  effort=high");
  expect(hinted("/settings eff", complete, 20)).toBe("  effort=low  effor…");
  expect(hinted("/settings eff", complete, 5)).toBe("");
  expect(hinted("/settings effort=low", complete, 60)).toBe("");
  expect(hinted("hello", complete, 60)).toBe("");
  // A completion that adds only the space before the next word shows nothing.
  expect(hinted("/settings", () => ["/settings "], 60)).toBe("");
});
