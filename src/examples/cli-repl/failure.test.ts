/** How the CLI words a failed turn. */

import { expect } from "bun:test";
import { Schema } from "effect";
import { test } from "../../../tests/support/test.ts";
import { Fact } from "../../agent-machine/fact.ts";
import { TurnId } from "../../agent-machine/names.ts";
import { errorLines, failureOf } from "./failure.ts";

const received = (text: string) => ({ mediaType: "application/json", body: { _tag: "Text", text } });

/** The facts of a turn whose model request failed with `error` (the AI client's error, as recorded) and `failure`. */
const failedTurn = (error: unknown, failure: string): ReadonlyArray<Fact> =>
  [
    { _tag: "Observed", seq: 1, time: "2026-10-06T22:17:38.338Z", origin: { _tag: "Harness", part: "loop" }, observation: { _tag: "TurnStarted", turn: "turn-1" } },
    { _tag: "Observed", seq: 2, time: "2026-10-06T22:17:38.342Z", origin: { _tag: "Harness", part: "loop" }, observation: { _tag: "ModelRequestDispatched", turn: "turn-1", provider: "anthropic", model: "claude-sonnet-4-5", sent: received("{}") } },
    { _tag: "Observed", seq: 3, time: "2026-10-06T22:17:38.646Z", origin: { _tag: "Provider", provider: "anthropic" }, observation: { _tag: "ModelFailed", turn: "turn-1", failure, request: received("{}"), error: received(JSON.stringify(error)) } },
    { _tag: "Decided", seq: 4, time: "2026-10-06T22:17:38.646Z", decision: { _tag: "TurnEnded", turn: "turn-1", ending: { _tag: "Failed", failure } } },
  ].map((fact) => Schema.decodeUnknownSync(Fact)(fact));

const providerAnswer = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "This model does not support the effort parameter." }, request_id: "req_011CfmkvuNU1zH1yhUmQrTRn" });

test("a provider's refusal names the model, says what the provider did, quotes its message, and keeps the HTTP status and the request's id", () => {
  const facts = failedTurn({ _tag: "AiError", module: "AnthropicModelClient", method: "respond", reason: { _tag: "InvalidRequestError", description: `HTTP 400: ${providerAnswer}` } }, `AnthropicModelClient.respond: Invalid request. HTTP 400: ${providerAnswer}`);
  expect(errorLines(failureOf(facts, TurnId.make("turn-1"))!)).toBe(
    "ERROR: anthropic/claude-sonnet-4-5 refused the request: This model does not support the effort parameter. (HTTP 400, request req_011CfmkvuNU1zH1yhUmQrTRn)",
  );
});

test("a refused API key comes with a hint naming the provider's key variable", () => {
  const facts = failedTurn({ _tag: "AiError", reason: { _tag: "AuthenticationError", description: `HTTP 401: ${JSON.stringify({ type: "error", error: { message: "invalid x-api-key" } })}` } }, "Authentication failed.");
  expect(errorLines(failureOf(facts, TurnId.make("turn-1"))!)).toBe("ERROR: anthropic/claude-sonnet-4-5 refused the API key: invalid x-api-key. (HTTP 401)\nHINT: Check that ANTHROPIC_API_KEY holds a valid key.");
});

test("a failure that is not a provider's is said as the session recorded it, and a turn that did not fail has no failure", () => {
  const facts = failedTurn({}, "Not sent: a policy holds model requests for now. Wait, then try again.");
  expect(failureOf(facts, TurnId.make("turn-1"))).toEqual({ message: "Not sent: a policy holds model requests for now. Wait, then try again." });
  expect(failureOf(facts.slice(0, 2), TurnId.make("turn-1"))).toBeUndefined();
});
