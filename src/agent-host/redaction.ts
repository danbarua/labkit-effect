/**
 * Redaction of a host's log lines. Two kinds of value are replaced by `<redacted>`:
 * - the values of the environment's credential variables, wherever they occur. A credential variable
 *   is one whose name is a credential name (`agent-process/environment.ts` `isCredentialName`:
 *   `GITHUB_PAT`, `OPENAI_API_KEY`, `SSH_AUTH_SOCK`);
 * - the value of a field named for a credential, whatever it is.
 *
 * A value shorter than `shortest` is not searched for, because replacing it everywhere would cut
 * ordinary text (`OPENAI_API_KEY=set` would turn `settings` into `<redacted>tings`). Each such
 * variable is reported once, when the logs are created, by its name and its value's length, never by
 * value.
 *
 * Secrets in data that the host does not hold (a provider's error echoing a key, a command's output)
 * are found only when they equal one of these values.
 */

import { Array as Arr, Effect, Layer, Logger, Order } from "effect";
import { isCredentialName, redactionPlaceholder } from "../agent-process/environment.ts";
import { logKeys } from "./log-keys.ts";

/** The minimum length of a credential value that is searched for. */
export const shortest = 8;

export interface Secrets {
  /** Replaced by `<redacted>` wherever they occur. */
  readonly values: ReadonlyArray<string>;
  /** The credential variables whose values are too short to search for: their names and lengths. */
  readonly tooShort: ReadonlyArray<{ readonly name: string; readonly length: number }>;
}

/** Returns the secrets of `env`: the non-empty values of its credential variables, with those shorter than `shortest` listed separately. */
export const secretsOf = (env: Readonly<Record<string, string | undefined>>): Secrets => {
  const credentials = Object.entries(env).flatMap(([name, value]) => (value !== undefined && value !== "" && isCredentialName(name) ? [{ name, value }] : []));
  return {
    values: credentials.flatMap(({ value }) => (value.length >= shortest ? [value] : [])),
    tooShort: credentials.flatMap(({ name, value }) => (value.length < shortest ? [{ name, length: value.length }] : [])),
  };
};

/** Field names whose value is a credential, whatever the value is. The pattern is anchored, so `inputTokens` does not match. */
const secretField =
  /^(?:api[-_]?key|x[-_]api[-_]key|authorization|proxy[-_]authorization|password|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|cookie|set-cookie)$/i;

/** Returns a function that replaces each of `values` in a text, the longest first, so that a secret containing another is replaced whole. */
export const redactorOf = (values: ReadonlyArray<string>) => {
  const ordered = Arr.sort(
    Arr.dedupe(values.filter((value) => value !== "")),
    Order.mapInput(Order.flip(Order.Number), (value: string) => value.length),
  );
  return (text: string): string => ordered.reduce((redacted, secret) => redacted.replaceAll(secret, redactionPlaceholder), text);
};

/**
 * Returns `value` as a JSON value, with `redact` applied to each text in it and each credential
 * field's value replaced by `<redacted>`. Errors become their name, message, stack and causes.
 * `enclosing` is the objects that `value` is nested in; a reference to one of them is a cycle,
 * written `[Circular]`. An object referenced twice without a cycle is written in full both times.
 */
export const redactedValue = (value: unknown, redact: (text: string) => string, enclosing: ReadonlyArray<object> = []): unknown => {
  if (typeof value === "string") return redact(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === null) return value;
  if (enclosing.includes(value)) return "[Circular]";
  const within = [...enclosing, value];
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redactedValue(item, redact, within));
  if (value instanceof Map || value instanceof Set) return [...value].map((item) => redactedValue(item, redact, within));
  if (!(value instanceof Error) && "toJSON" in value && typeof value.toJSON === "function") return redactedValue(value.toJSON(), redact, within);
  const ofError =
    value instanceof Error
      ? {
          name: redact(value.name),
          message: redact(value.message),
          ...(value.stack === undefined ? {} : { stack: redact(value.stack) }),
          ...(value.cause === undefined ? {} : { cause: redactedValue(value.cause, redact, within) }),
        }
      : {};
  // An error's own enumerable fields come after its name, message, stack and cause, and override them.
  return {
    ...ofError,
    ...Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), secretField.test(key) ? redactionPlaceholder : redactedValue(item, redact, within)])),
  };
};

/** Returns `formatter` applied to each record's redacted message (`redactedValue`), with the secrets then removed from the whole line. */
export const redacting = (secrets: Secrets, formatter: Logger.Logger<unknown, string>): Logger.Logger<unknown, string> => {
  const redact = redactorOf(secrets.values);
  return Logger.make((options) => redact(formatter.log({ ...options, message: redactedValue(options.message, redact) })));
};

/** Logs a warning naming the credential variables whose values are too short to search for, if any, by name and length. */
export const saidTooShort = (secrets: Secrets): Effect.Effect<void> =>
  secrets.tooShort.length === 0 ? Effect.void : Effect.logWarning(logKeys.logs.secretsNotLookedFor, { variables: secrets.tooShort, shortest });

/** Returns `logs`, which first log a warning naming the secrets they do not search for. */
export const sayingTooShort = <E, R>(secrets: Secrets, logs: Layer.Layer<never, E, R>): Layer.Layer<never, E, R> =>
  Layer.merge(logs, Layer.effectDiscard(saidTooShort(secrets)).pipe(Layer.provide(logs)));
