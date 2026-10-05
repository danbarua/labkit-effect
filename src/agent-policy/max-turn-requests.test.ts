/** The limit on a turn's model requests: a request beyond the limit is vetoed, and the veto ends the turn (ACP's max_turn_requests). */

import { expect } from "bun:test";
import { observe, open, opened } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";
import { test } from "../../tests/support/test.ts";
import { TurnId } from "../agent-machine/names.ts";
import type { EffectRequest } from "../agent-machine/request.ts";
import { defaultMaxTurnRequests, maxTurnRequests } from "./max-turn-requests.ts";

const askModel = (turn: string): EffectRequest => ({ _tag: "RequestModelResponse", turn: TurnId.make(turn) });

test("a model request beyond the turn's limit is vetoed with the reason { stop: max_turn_requests, limit }, and the veto ends the turn", () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  expect(maxTurnRequests(session.journal, 1).start(askModel("turn-1"))).toEqual({ _tag: "Decided", verdict: { _tag: "Continue" } });
  observe(session, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "boring",
    model: "boring-1",
    parts: [{ _tag: "ToolCall", call: "c1", tool: "ls", input: json({}) }],
    ending: { _tag: "Complete" },
    metadata: json({}),
  });
  observe(session, { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Succeeded", output: json([]) } });
  // The second request's decision (`TellModel`) is recorded before the request is reviewed.
  const second = maxTurnRequests(session.journal, 1).start(askModel("turn-1"));
  expect(second as unknown).toEqual({ _tag: "Decided", verdict: { _tag: "Veto", reason: json({ stop: "max_turn_requests", limit: 1 }) } });
  observe(session, { _tag: "ModelVetoed", turn: "turn-1", reason: json({ stop: "max_turn_requests", limit: 1 }) });
  expect(session.journal.at(-1) as unknown).toMatchObject({ decision: { _tag: "TurnEnded", ending: { _tag: "Vetoed" } } });
  // By default the limit is 1000: the second request runs.
  expect(defaultMaxTurnRequests).toBe(1000);
  expect(maxTurnRequests(session.journal).start(askModel("turn-1"))).toEqual({ _tag: "Decided", verdict: { _tag: "Continue" } });
});
