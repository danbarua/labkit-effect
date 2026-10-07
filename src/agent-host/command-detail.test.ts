/** A permission question's detail, shown as Markdown for ACP and as plain lines for the REPL. */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { CodeText, type Detail } from "../agent-policy/command-units.ts";
import { Explanation } from "../agent-policy/sed-script.ts";
import { markdownOf, terminalOf } from "./command-detail.ts";

const code = (text: string): Detail => ({ _tag: "Code", language: "bash", code: CodeText.make(text) });
const explained: Detail = {
  _tag: "Explained",
  lines: [
    { depth: 0, text: Explanation.make("Reads f:") },
    { depth: 1, text: Explanation.make("On lines matching `x`:") },
    { depth: 2, text: Explanation.make("Deletes those lines.") },
  ],
};

test("code is fenced with its language, in Markdown and in the terminal alike", () => {
  expect(markdownOf(code("ls\npwd"))).toEqual(["```bash", "ls", "pwd", "```"]);
  expect(terminalOf(code("ls\npwd"))).toEqual(["```bash", "ls", "pwd", "```"]);
});

test("a fence is one backtick longer than the longest run of backticks in the code", () => {
  expect(markdownOf(code("echo ```"))).toEqual(["````bash", "echo ```", "````"]);
});

test("an explanation is a lead line and a nested list in Markdown, and lines indented by depth in the terminal", () => {
  expect(markdownOf(explained)).toEqual(["Reads f:", "- On lines matching `x`:", "  - Deletes those lines."]);
  expect(terminalOf(explained)).toEqual(["Reads f:", "  On lines matching `x`:", "    Deletes those lines."]);
});
