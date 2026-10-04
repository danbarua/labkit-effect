/**
 * What a host's log lines leave out: the values of the environment's credentials, wherever they
 * occur, and the value of a field named for a credential, whatever it is. A credential's variable is
 * one whose name is a credential's (`agent-process/environment.ts` `isCredential`: `GITHUB_PAT`,
 * `OPENAI_API_KEY`, `SSH_AUTH_SOCK`).
 *
 * A value shorter than `shortest` is not looked for: replaced wherever it occurs, it would cut
 * ordinary text (`OPENAI_API_KEY=set` would make `settings` `[redacted]tings`). Each one left out is
 * said once, when the logs are made, by its variable's name and its length, never its value.
 *
 * Secrets in data the host does not hold (a provider's error echoing a key, a command's output) are
 * found only when they are one of these values.
 */

import { Effect, Layer, Logger } from "effect";
import { isCredential } from "../agent-process/environment.ts";

/** The fewest characters a credential's value has to be looked for. */
export const shortest = 8;

/** What the log of each credential's variable left out says. */
export const secretsNotLookedFor = "host_logs.secrets_not_looked_for";

export interface Secrets {
  /** Replaced by `[redacted]` wherever they occur. */
  readonly values: ReadonlyArray<string>;
  /** The credentials' variables whose values are too short to be looked for: their names and lengths. */
  readonly tooShort: ReadonlyArray<{ readonly name: string; readonly length: number }>;
}

/** The secrets of `env`: the non-empty values of its credentials' variables, those shorter than `shortest` set aside. */
export const secretsOf = (env: Readonly<Record<string, string | undefined>>): Secrets => {
  const credentials = Object.entries(env).flatMap(([name, value]) => (value !== undefined && value !== "" && isCredential(name) ? [{ name, value }] : []));
  return {
    values: credentials.flatMap(({ value }) => (value.length >= shortest ? [value] : [])),
    tooShort: credentials.flatMap(({ name, value }) => (value.length < shortest ? [{ name, length: value.length }] : [])),
  };
};

/** Fields whose value is a credential whatever it is. Anchored: `inputTokens` is not one. */
const secretField =
  /^(?:api[-_]?key|x[-_]api[-_]key|authorization|proxy[-_]authorization|password|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|cookie|set-cookie)$/i;

/** Replaces each of `values` in a text, the longest first so a secret holding another goes whole. */
export const redactorOf = (values: ReadonlyArray<string>) => {
  const ordered = [...new Set(values.filter((value) => value !== ""))].sort((a, b) => b.length - a.length);
  return (text: string): string => ordered.reduce((redacted, secret) => redacted.replaceAll(secret, "[redacted]"), text);
};

/**
 * `value` as JSON holds it, `redact` applied to each text in it and a credential field's value
 * `[redacted]`: errors with their name, message, stack and causes; circular references named.
 */
export const redactedValue = (value: unknown, redact: (text: string) => string, seen = new WeakSet<object>()): unknown => {
  if (typeof value === "string") return redact(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
    if (Array.isArray(value)) return value.map((item) => redactedValue(item, redact, seen));
    if (value instanceof Map || value instanceof Set) return [...value].map((item) => redactedValue(item, redact, seen));
    if (!(value instanceof Error) && "toJSON" in value && typeof value.toJSON === "function") return redactedValue(value.toJSON(), redact, seen);
    const out: Record<string, unknown> =
      value instanceof Error
        ? {
            name: redact(value.name),
            message: redact(value.message),
            ...(value.stack === undefined ? {} : { stack: redact(value.stack) }),
            ...(value.cause === undefined ? {} : { cause: redactedValue(value.cause, redact, seen) }),
          }
        : {};
    for (const [key, item] of Object.entries(value)) out[redact(key)] = secretField.test(key) ? "[redacted]" : redactedValue(item, redact, seen);
    return out;
  } finally {
    seen.delete(value);
  }
};

/** `formatter`, given each record's message redacted (`redactedValue`), its line then rid of the secrets wherever they are. */
export const redacting = (secrets: Secrets, formatter: Logger.Logger<unknown, string>): Logger.Logger<unknown, string> => {
  const redact = redactorOf(secrets.values);
  return Logger.make((options) => redact(formatter.log({ ...options, message: redactedValue(options.message, redact) })));
};

/** Says the credentials' variables whose values are not looked for, if any: a warning, by name and length. */
export const saidTooShort = (secrets: Secrets): Effect.Effect<void> =>
  secrets.tooShort.length === 0 ? Effect.void : Effect.logWarning(secretsNotLookedFor, { variables: secrets.tooShort, shortest });

/** `logs`, which say first, in themselves, what of `secrets` they do not look for. */
export const sayingTooShort = <E, R>(secrets: Secrets, logs: Layer.Layer<never, E, R>): Layer.Layer<never, E, R> =>
  Layer.merge(logs, Layer.effectDiscard(saidTooShort(secrets)).pipe(Layer.provide(logs)));
