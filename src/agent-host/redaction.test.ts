/** redactedValue: how a log record's message is made safe to write as JSON. */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { redactedValue, redactorOf } from "./redaction.ts";

const redact = redactorOf(["s3cr3t-value"]);

test("redactedValue returns JSON values: a bigint as a string, a valid date as ISO text, an invalid date as its text, a Map or a Set as an array", () => {
  expect(redactedValue(12n, redact)).toBe("12");
  expect(redactedValue(new Date("2026-10-04T12:00:00.000Z"), redact)).toBe("2026-10-04T12:00:00.000Z");
  expect(redactedValue(new Date("not a date"), redact)).toBe("Invalid Date");
  expect(redactedValue(new Map([["k", "s3cr3t-value here"]]), redact)).toEqual([["k", "<redacted> here"]]);
  expect(redactedValue(new Set(["a", "s3cr3t-value"]), redact)).toEqual(["a", "<redacted>"]);
});

test("redactedValue uses an object's toJSON, redacts text in keys and values, and replaces a credential field's value whatever it is", () => {
  expect(redactedValue({ toJSON: () => ({ said: "s3cr3t-value" }) }, redact)).toEqual({ said: "<redacted>" });
  expect(redactedValue({ "s3cr3t-value": 1, authorization: "Bearer anything", inputTokens: 5 }, redact)).toEqual({ "<redacted>": 1, authorization: "<redacted>", inputTokens: 5 });
});

test("redactedValue returns an error as its name, message, stack and cause, redacted", () => {
  const value = redactedValue(new Error("failed with s3cr3t-value", { cause: new Error("inner") }), redact) as Record<string, unknown>;
  expect(value).toMatchObject({ name: "Error", message: "failed with <redacted>", cause: { name: "Error", message: "inner" } });
  expect(value["stack"]).toContain("failed with <redacted>");
});

test("redactedValue replaces a reference to an enclosing object with [Circular], and returns an object referenced twice, without a cycle, in full both times", () => {
  const cyclic: Record<string, unknown> = { name: "a" };
  cyclic["self"] = cyclic;
  expect(redactedValue(cyclic, redact)).toEqual({ name: "a", self: "[Circular]" });
  const shared = { n: 1 };
  expect(redactedValue({ first: shared, second: shared }, redact)).toEqual({ first: { n: 1 }, second: { n: 1 } });
});

test("when one secret contains another, the longer one is replaced whole", () => {
  const redact = redactorOf(["abcdefgh", "abcdefgh-0123456789"]);
  expect(redact("token abcdefgh-0123456789 and abcdefgh")).toBe("token <redacted> and <redacted>");
});
