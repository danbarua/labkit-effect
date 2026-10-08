/** `codeSpan`: a name as a Markdown code span, whatever backticks it holds. */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { codeSpan } from "./code-span.ts";

test("a name is put between backticks, so Markdown shows *.ts and __init__.py as written", () => {
  expect(codeSpan("*.ts")).toBe("`*.ts`");
  expect(codeSpan("__init__.py")).toBe("`__init__.py`");
});

test("a name that holds backticks is put between one more backtick than its longest run, padded with a space when it starts or ends with one", () => {
  expect(codeSpan("a`b")).toBe("``a`b``");
  expect(codeSpan("a``b")).toBe("```a``b```");
  expect(codeSpan("`x`")).toBe("`` `x` ``");
});
