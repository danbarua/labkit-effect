/** How a turn ended, as ACP's answer to the prompt that began it. */

import { Effect } from "effect";
import { expect } from "bun:test";
import { observe, open, opened } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";
import { test } from "../../tests/support/test.ts";
import { TurnId } from "../agent-machine/names.ts";
import { receivedText } from "../agent-session/received.ts";
import { noticeOf, stopOf } from "./stop-reason.ts";

const responded = (parts: ReadonlyArray<unknown>, ending: string) => ({
  _tag: "ModelResponded",
  turn: "turn-1",
  provider: "boring",
  model: "boring-1",
  parts,
  ending: { _tag: ending },
  metadata: json({}),
});

const answer = { _tag: "Text", text: "Done." };
const thinking = { _tag: "Thinking", text: "Hmm.", received: json({ thinking: "Hmm." }) };

/** A turn given `outcomes` after its input: how it ended, by the facts, and the answer to its prompt. */
const ended = (...outcomes: ReadonlyArray<unknown>) => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "go" });
  for (const outcome of outcomes) observe(session, outcome);
  const turnEnded = session.journal.find((fact) => fact._tag === "Decided" && fact.decision._tag === "TurnEnded");
  const ending = turnEnded?._tag === "Decided" && turnEnded.decision._tag === "TurnEnded" ? turnEnded.decision.ending._tag : undefined;
  return [ending, stopOf(session.journal, TurnId.make("turn-1"))];
};

test("each ending gives its stop reason, or an error carrying why", () => {
  expect([
    ended(responded([answer], "Complete")),
    ended(responded([thinking], "Complete")),
    ended(responded([answer], "CutShort")),
    ended({ _tag: "TurnInterrupted", turn: "turn-1" }, responded([], "Interrupted")),
    ended({ _tag: "ModelFailed", turn: "turn-1", failure: "the server answered 503", error: json({ status: 503 }) }),
  ]).toEqual([
    ["Completed", { stopReason: "end_turn" }],
    ["Incomplete", { stopReason: "end_turn" }],
    ["CutShort", { stopReason: "max_tokens" }],
    ["Interrupted", { stopReason: "cancelled" }],
    ["Failed", { error: { code: -32603, message: "the server answered 503" } }],
  ]);
});

test("a veto by the turn-request limit is max_turn_requests; any other veto is an error carrying its reason", () => {
  expect([
    ended({ _tag: "ModelVetoed", turn: "turn-1", reason: json({ stop: "max_turn_requests", limit: 3 }) }),
    ended({ _tag: "ModelVetoed", turn: "turn-1", reason: receivedText("No requests after midnight.") }),
    ended({ _tag: "ModelVetoed", turn: "turn-1", reason: json({ stop: "budget" }) }),
  ]).toEqual([
    ["Vetoed", { stopReason: "max_turn_requests" }],
    ["Vetoed", { error: { code: -32603, message: "No requests after midnight." } }],
    ["Vetoed", { error: { code: -32603, message: '{"stop":"budget"}' } }],
  ]);
});

test("a turn whose last response the provider refused stops with refusal, whatever its ending", () => {
  expect([ended(responded([], "Refused")), ended(responded([answer], "Refused"))]).toEqual([
    [expect.any(String), { stopReason: "refusal" }],
    [expect.any(String), { stopReason: "refusal" }],
  ]);
});

test("refusal is read from the turn's last response: one refused after a call stops with refusal", () => {
  const call = { _tag: "ToolCall", call: "c1", tool: "ls", input: json({}) };
  expect(
    ended(responded([call], "Complete"), { _tag: "ToolCallDispatched", call: "c1" }, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json([]) } }, responded([], "Refused")),
  ).toEqual([expect.any(String), { stopReason: "refusal" }]);
});

test("a turn that has not ended has no stop reason", () => {
  expect(ended()).toEqual([undefined, undefined]);
});

/** The notice for the stop of a turn opened with `settings` and given `outcomes` after its input. */
const noticed = (settings: Record<string, unknown> | undefined, ...outcomes: ReadonlyArray<unknown>) => {
  const session = open();
  observe(session, settings === undefined ? opened : { ...opened, model: { ...opened.model, settings } });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "go" });
  for (const outcome of outcomes) observe(session, outcome);
  const stop = stopOf(session.journal, TurnId.make("turn-1"));
  return stop === undefined || "error" in stop ? undefined : Effect.runSync(noticeOf(session.journal, TurnId.make("turn-1"), stop.stopReason));
};

const cutShort = { ...responded([answer], "CutShort"), stop: "max_tokens", usage: { input: 900, output: 4096 } };

test("a reply cut short at a length limit is explained by a warning naming the model, the output tokens it used and the output limit the request was sent with, adjusted or given", () => {
  const adjusted = { _tag: "SettingAdjusted", turn: "turn-1", provider: "boring", model: "boring-1", adjusted: { _tag: "MaxOutputTokens", asked: 128000, used: 64000 }, reason: "this model's output limit is 64000 tokens" };
  expect([noticed({ maxOutputTokens: 4096 }, cutShort), noticed({ maxOutputTokens: 128000 }, adjusted, cutShort)]).toEqual([
    {
      sessionUpdate: "notice",
      severity: "warning",
      title: "The reply was cut short",
      description: "boring/boring-1 stopped at a length limit after 4,096 output tokens. The request set the output limit to 4,096 tokens. The provider's stop reason: max_tokens.",
    },
    {
      sessionUpdate: "notice",
      severity: "warning",
      title: "The reply was cut short",
      description: "boring/boring-1 stopped at a length limit after 4,096 output tokens. The request set the output limit to 64,000 tokens. The provider's stop reason: max_tokens.",
    },
  ]);
});

test("a max_tokens stop states no output limit when the settings give none, and no length limit when the response's ending was not classified", () => {
  expect(noticed(undefined, { ...responded([answer], "Unclassified"), stop: "something_new", usage: { input: 900, output: 12 } })).toEqual({
    sessionUpdate: "notice",
    severity: "warning",
    title: "The reply was cut short",
    description: "boring/boring-1 stopped before finishing its reply after 12 output tokens. The provider's stop reason: something_new.",
  });
});

test("a refusal is explained by a warning naming the model, quoting the provider's stop reason and the refusal text the response carries", () => {
  const refusal = { _tag: "Unrecognised", received: json({ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "I can't help with that." }] }) };
  expect([noticed(undefined, { ...responded([refusal], "Refused"), stop: "incomplete: content_filter" }), noticed(undefined, responded([], "Refused"))]).toEqual([
    {
      sessionUpdate: "notice",
      severity: "warning",
      title: "The model declined to continue",
      description: `boring/boring-1 declined to continue. The provider's stop reason: incomplete: content_filter. It said: "I can't help with that."`,
    },
    { sessionUpdate: "notice", severity: "warning", title: "The model declined to continue", description: "boring/boring-1 declined to continue." },
  ]);
});

test("a turn that stops with end_turn or cancelled has no notice", () => {
  expect([noticed(undefined, responded([answer], "Complete")), noticed(undefined, { _tag: "TurnInterrupted", turn: "turn-1" }, responded([], "Interrupted"))]).toEqual([undefined, undefined]);
});
