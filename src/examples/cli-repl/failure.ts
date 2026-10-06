/**
 * A failed turn as the CLI tells the user (`ERROR:` and, when there is something to do, `HINT:`).
 * A model request's failure names the model, says what the provider did in the user's words, and
 * quotes the provider's own message, with the HTTP status and the request's id when the provider
 * sent them, so that the failure can be looked up. A failure that is not a provider's (a policy that
 * held the request) is said as the session recorded it.
 */

import { Predicate } from "effect";
import { keyVariables } from "../../agent-host/catalog.ts";
import type { Fact } from "../../agent-machine/fact.ts";
import type { TurnId } from "../../agent-machine/names.ts";
import { asText } from "../../agent-session/received.ts";
import { endingOf } from "./session.ts";

/** What the provider did, after the model's name, for each kind of failure that the AI client reports. */
const done: Readonly<Record<string, string>> = {
  InvalidRequestError: "refused the request",
  AuthenticationError: "refused the API key",
  RateLimitError: "is limiting requests",
  QuotaExhaustedError: "has no quota left for this account",
  InternalProviderError: "failed on the provider's side",
  NetworkError: "could not be reached",
  ContentPolicyError: "refused the request under its content policy",
  InvalidOutputError: "answered with output that could not be read",
};

/** Returns `text` parsed as JSON, or undefined when it is not JSON. */
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Returns `value[key]` when `value` is an object and that field is a string. */
const textAt = (value: unknown, key: string): string | undefined => (Predicate.isReadonlyObject(value) && typeof value[key] === "string" ? value[key] : undefined);

/**
 * Returns what an error's description (`HTTP 400: {…}`) holds: the HTTP status, the provider's own
 * message (`error.message`, `message`, or `error` as text), and the request's id (`request_id`).
 */
const detailsOf = (description: string) => {
  const match = /^HTTP (\d{3}): ([\s\S]*)$/.exec(description);
  const body = match === null ? undefined : parsed(match[2] ?? "");
  const error = Predicate.isReadonlyObject(body) ? body["error"] : undefined;
  return {
    status: match?.[1],
    message: textAt(error, "message") ?? textAt(body, "message") ?? (typeof error === "string" ? error : undefined),
    request: textAt(body, "request_id"),
  };
};

/** How a turn failed, for the user. */
export interface Failure {
  readonly message: string;
  readonly hint?: string;
}

/** Returns how `turn` failed, for the user, when it failed; undefined when it did not. */
export const failureOf = (facts: ReadonlyArray<Fact>, turn: TurnId | undefined): Failure | undefined => {
  const ending = endingOf(facts, turn);
  if (ending?._tag !== "Failed") return undefined;
  const observed = facts.flatMap((fact) => (fact._tag === "Observed" ? [fact.observation] : []));
  const dispatched = observed.filter((each) => each._tag === "ModelRequestDispatched" && each.turn === turn).at(-1);
  const failed = observed.filter((each) => each._tag === "ModelFailed" && each.turn === turn).at(-1);
  const error = failed?._tag === "ModelFailed" ? parsed(asText(failed.error)) : undefined;
  const reason = Predicate.isReadonlyObject(error) ? error["reason"] : undefined;
  const kind = textAt(reason, "_tag");
  if (kind === undefined || dispatched?._tag !== "ModelRequestDispatched") return { message: ending.failure.replace(/\.?$/, ".") };
  const { status, message, request } = detailsOf(textAt(reason, "description") ?? "");
  const said = (message ?? textAt(reason, "description") ?? ending.failure).replace(/\.$/, "");
  const lookup = [...(status === undefined ? [] : [`HTTP ${status}`]), ...(request === undefined ? [] : [`request ${request}`])];
  const variable = keyVariables[dispatched.provider];
  return {
    message: `${dispatched.provider}/${dispatched.model} ${done[kind] ?? "failed"}: ${said}.${lookup.length === 0 ? "" : ` (${lookup.join(", ")})`}`,
    ...(kind === "AuthenticationError" && variable !== undefined ? { hint: `Check that ${variable} holds a valid key.` } : {}),
  };
};

/** Returns `failure` as the CLI prints an error: an `ERROR:` line, and a `HINT:` line when it has one. */
export const errorLines = (failure: Failure): string => `ERROR: ${failure.message}${failure.hint === undefined ? "" : `\nHINT: ${failure.hint}`}`;
