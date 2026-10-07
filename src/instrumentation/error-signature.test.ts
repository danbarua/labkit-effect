/** `errorSignature`: failure texts that differ only in ids and counters have one signature. */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { errorSignature, signatureLength } from "./error-signature.ts";

/** An Anthropic refusal, as the adapter words it, with the request's id in the provider's answer. */
const refusal = (requestId: string) =>
  `AnthropicModelClient.respond: Invalid request. HTTP 400: ${JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "This model does not support the effort parameter." }, request_id: requestId })}`;

test("two refusals that differ only in the provider's request id have one signature, which keeps the HTTP status and the model's name", () => {
  const first = errorSignature(refusal("req_011CfmkvuNU1zH1yhUmQrTRn"));
  expect(first).toBe(errorSignature(refusal("req_011CZ8a2rQx7VvKpL3mNbT4e")));
  expect(first).toBe(
    'AnthropicModelClient.respond: Invalid request. HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":"This model does not support the effort parameter."},"request_id":"req_<id>"}',
  );
  expect(errorSignature("claude-sonnet-4-5 refused: HTTP 529: Overloaded")).toBe("claude-sonnet-4-5 refused: HTTP 529: Overloaded");
});

test("UUIDs, message and completion ids, long hex and free-standing numbers become placeholders; whitespace collapses", () => {
  expect(
    errorSignature(
      "OpenAiCompatClient.respond: Invalid output: tool call chatcmpl-9fA2kLmQ7rT0 in msg_01XyZ8a2rQx7Vv for session 0199c3a2-7f4e-7b1a-9c2d-3e4f5a6b7c8d\n\n  at offset 1834,   sha 3f9a0c2b7e1d44aa90bc",
    ),
  ).toBe("OpenAiCompatClient.respond: Invalid output: tool call chatcmpl_<id> in msg_<id> for session <uuid> at offset <n>, sha <hex>");
  // A rate limit's wait and a context window's counts vary between occurrences of the same failure.
  expect(errorSignature("prompt is too long: 214785 tokens > 200000 maximum")).toBe(errorSignature("prompt is too long: 201003 tokens > 200000 maximum"));
});

test("a long failure is cut to the signature's length, ending in an ellipsis", () => {
  const signature = errorSignature(`Internal provider error: ${"stack frame ".repeat(100)}`);
  expect(signature.length).toBe(signatureLength);
  expect(signature.endsWith("…")).toBe(true);
});
