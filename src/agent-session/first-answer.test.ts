/** `firstAnswer`: sources asked in order, the first that knows answering, and none after it asked. */

import { expect } from "bun:test";
import { Effect } from "effect";
import { test } from "../../tests/support/test.ts";
import { firstAnswer } from "./first-answer.ts";

test("the first source that knows answers, and the sources after it are not asked; none knowing is undefined", () => {
  const asked: Array<string> = [];
  const source = (name: string, answer: string | undefined) => Effect.sync(() => (asked.push(name), answer));
  expect(Effect.runSync(firstAnswer([source("local", undefined), source("well-known", "known"), source("last", "other")]))).toBe("known");
  expect(asked).toEqual(["local", "well-known"]);
  expect(Effect.runSync(firstAnswer([source("none", undefined)]))).toBeUndefined();
  expect(Effect.runSync(firstAnswer<string>([]))).toBeUndefined();
});
