/** How a turn ended, as ACP's answer to the prompt that began it. */

import { expect } from "bun:test";
import { observe, open, opened } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";
import { test } from "../../tests/support/test.ts";
import { TurnId } from "../agent-machine/names.ts";
import { receivedText } from "../agent-session/received.ts";
import { stopOf } from "./stop-reason.ts";

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

test("AA8: each ending is its stop reason, or an error carrying why", () => {
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

test("AA8: a veto by the turn-request limit is max_turn_requests; any other veto is an error carrying its reason", () => {
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

test("AA8: a turn whose last response the provider refused stops with refusal, whatever its ending", () => {
  expect([ended(responded([], "Refused")), ended(responded([answer], "Refused"))]).toEqual([
    [expect.any(String), { stopReason: "refusal" }],
    [expect.any(String), { stopReason: "refusal" }],
  ]);
});

test("AA8: a turn that has not ended has no stop reason", () => {
  expect(ended()).toEqual([undefined, undefined]);
});
