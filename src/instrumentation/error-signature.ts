/**
 * A failure's signature: its text with what differs between occurrences of the same failure
 * replaced, so that failures can be grouped by it (`error_signature` on a model request's and a
 * model attempt's span).
 *
 * - UUIDs become `<uuid>`.
 * - Identifiers with a prefix, such as a request's (`req_…`), a message's (`msg_…`), a tool call's
 *   (`toolu_…`, `call_…`) or a completion's (`chatcmpl-…`), become `<prefix>_<id>`.
 * - Runs of 12 or more hexadecimal digits become `<hex>`.
 * - Numbers become `<n>`, except an HTTP status after `HTTP `, which tells failures apart. Digits
 *   inside a name (`gpt-5.5`, `claude-sonnet-4-5`) are kept.
 * - Runs of whitespace become one space, and the ends are trimmed.
 * - The result is cut to `signatureLength` characters, the last of them `…` when it was cut.
 */

/** The longest signature, in characters. */
export const signatureLength = 200;

const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const prefixedId = /\b(req|msg|resp|call|toolu|chatcmpl|run|gen|file|batch|org|user|sess)[-_][A-Za-z0-9_-]{6,}/g;
const hex = /\b[0-9a-f]{12,}\b/gi;
/** A number standing on its own, not inside a name; an HTTP status after `HTTP ` is matched with its prefix, and kept. */
const number = /(HTTP [1-5]\d\d\b)|(?<![\w.-])\d+(?:\.\d+)?/g;

/** Returns the signature of a failure's text (see the module's description). */
export function errorSignature(text: string): string {
  const normalised = text
    .replace(uuid, "<uuid>")
    .replace(prefixedId, (_, prefix: string) => `${prefix}_<id>`)
    .replace(hex, "<hex>")
    .replace(number, (_, status: string | undefined) => status ?? "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return normalised.length > signatureLength ? `${normalised.slice(0, signatureLength - 1)}…` : normalised;
}
