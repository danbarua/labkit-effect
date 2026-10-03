/** What a session has used, read from its facts: the context gauge, its cost, and a turn's requests. */

import { expect } from "bun:test";
import { observe, open, opened } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";
import { test } from "../../tests/support/test.ts";
import { TokenCount, TurnId } from "../agent-machine/names.ts";
import { contextGauge, costOf } from "./accounting.ts";
import { requestsIn } from "../agent-machine/turn-requests.ts";
import { capabilitiesOf } from "./configuration/well-known-models.ts";

const tokens = (count: number) => TokenCount.make(count);

const responded = (usage: unknown, parts: ReadonlyArray<unknown> = [{ _tag: "Text", text: "Done." }]) => ({
  _tag: "ModelResponded",
  turn: "turn-1",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  parts,
  ending: { _tag: "Complete" },
  ...(usage === undefined ? {} : { usage }),
  metadata: json({}),
});

test("a response's cost: input not cached, cache reads, cache writes and output, each at its price per million", () => {
  const sonnet = capabilitiesOf("anthropic", "claude-sonnet-5-5")?.price;
  if (sonnet === undefined) throw new Error("claude-sonnet-5-5 is not a well-known model");
  // 1,000 uncached at $2, 3,000 read at $0.20, 1,000 written at $2.50, 500 out at $10, per million.
  const cost = costOf({ input: tokens(5000), cacheRead: tokens(3000), cacheWrite: tokens(1000), output: tokens(500) }, sonnet);
  expect(cost).toBeCloseTo((1000 * 2 + 3000 * 0.2 + 1000 * 2.5 + 500 * 10) / 1_000_000, 12);
});

test("cache writes kept for an hour are priced at their own rate, the rest at the five-minute rate", () => {
  const sonnet = capabilitiesOf("anthropic", "claude-sonnet-5-5")?.price;
  if (sonnet === undefined) throw new Error("claude-sonnet-5-5 is not a well-known model");
  expect(costOf({ input: tokens(3000), cacheWrite: tokens(3000), cacheWrite1h: tokens(1000), output: tokens(0) }, sonnet)).toBeCloseTo(
    (2000 * 2.5 + 1000 * 4) / 1_000_000,
    12,
  );
});

test("a request whose input is over a tier's context is priced at the higher tier", () => {
  const sol = capabilitiesOf("openai", "gpt-6.1-sol")?.price;
  if (sol === undefined) throw new Error("gpt-6.1-sol is not a well-known model");
  expect(costOf({ input: tokens(100_000), output: tokens(0) }, sol)).toBeCloseTo((100_000 * 2) / 1_000_000, 12);
  expect(costOf({ input: tokens(300_000), output: tokens(0) }, sol)).toBeCloseTo((300_000 * 4) / 1_000_000, 12);
});

test("the context gauge: tokens in context after the last response, the model's window, and the session's cost so far", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "hello" });
  observe(session, responded({ input: 1200, output: 300 }));
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "and again" });
  observe(session, responded({ input: 1600, output: 200, thinking: 50, cacheRead: 1200 }));
  const gauge = contextGauge(session.journal, "anthropic", "claude-sonnet-5-5");
  // Visible tokens: the request's 1,600 and the response's 200 less its 50 of thinking.
  expect(gauge).toMatchObject({ used: 1750, size: 1_000_000, cost: { currency: "USD" } });
  expect(gauge?.cost?.amount).toBeCloseTo((1200 * 2 + 300 * 10 + 400 * 2 + 1200 * 0.2 + 200 * 10) / 1_000_000, 12);
  // A model whose window is not known has no gauge. A response with no usage (interrupted, say), or
  // from a model with no price, adds nothing to the cost.
  expect(contextGauge(session.journal, "boring", "boring-1")).toBeUndefined();
  const before = gauge?.cost.amount;
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "once more" });
  observe(session, responded(undefined));
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "and locally" });
  observe(session, { ...responded({ input: 900, output: 100 }), provider: "localhost", model: "qwen" });
  expect(contextGauge(session.journal, "anthropic", "claude-sonnet-5-5")?.cost.amount).toBe(before);
});

test("a turn's requests are its steps", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  observe(session, responded(undefined, [{ _tag: "ToolCall", call: "c1", tool: "ls", input: json({}) }]));
  observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json([]) } });
  observe(session, responded(undefined));
  expect(requestsIn(session.journal, TurnId.make("turn-1"))).toBe(2);
});
