/**
 * Removes credentials from the environment that a child process inherits, and from command
 * arguments before they are logged.
 *
 * A name is a credential name when one of its words is a credential word, in any letter case
 * (`CREDENTIAL_WORD_PATTERNS`), or when it matches a secret's format (`SECRET_VALUE_PATTERNS`).
 * - Credential names: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`,
 *   `SSH_AUTH_SOCK`, `apiKeyId`.
 * - Not credential names: `GIT_AUTHOR_NAME`, `PATH`, `MAX_TOKENS`, `monkey`.
 */

import { Array as Arr, Order } from "effect";

/** Formats of secret values. `isCredentialName` applies them to names as well. */
export const SECRET_VALUE_PATTERNS = [
  // URLs with credentials
  /(\S{1,1024}):\/\/[^:\s]{1,1024}:[^@\s]{1,1024}@/i,
  // GitHub tokens
  /(ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{36,}/i,
  // Google API keys
  /AIzaSy[a-zA-Z0-9_\\-]{33}/i,
  // Amazon AWS
  /AKIA[A-Z0-9]{16}/i,
  // Cryptography Certs and Keys
  /-----BEGIN CERTIFICATE-----/i,
  /-----BEGIN (RSA|OPENSSH|EC|PGP) PRIVATE KEY-----/i,
];

/**
 * Returns a pattern that matches `word` as a whole word of a name, in any letter case.
 * - A word starts at the start of the name, after `_`, `-` or `.`, or at an upper-case letter that
 *   follows a lower-case letter.
 * - A word ends at the end of the name, before `_`, `-` or `.`, or before an upper-case letter that
 *   follows a lower-case letter.
 *
 * For example, `apiKeyId` contains the word `Key`, and `monkey` does not contain the word `key`.
 */
const credentialWord = (word: string): RegExp => {
  const letters = word.split("").map((letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`).join("");
  return new RegExp(`(?:^|[_\\-.]|(?<=[a-z])(?=[A-Z]))${letters}(?=$|[_\\-.]|(?<=[a-z])[A-Z])`);
};

/** The credential words. A name that contains one of these words is a credential name. */
export const CREDENTIAL_WORD_PATTERNS: ReadonlyArray<RegExp> = [
  credentialWord("TOKEN"),
  credentialWord("KEY"),
  credentialWord("APIKEY"),
  credentialWord("AUTH"),
  credentialWord("SECRET"),
  credentialWord("PASS"),
  credentialWord("PASSWD"),
  credentialWord("PASSWORD"),
  credentialWord("CRED"),
  credentialWord("COOKIE"),
  credentialWord("PAT"),
  credentialWord("CERT"),
  credentialWord("CERTIFICATE"),
];

/** Returns true when `name` is a credential name: one of its words is a credential word, or it matches `SECRET_VALUE_PATTERNS`. */
export const isCredentialName = (name: string): boolean =>
  CREDENTIAL_WORD_PATTERNS.some((pattern) => pattern.test(name)) || SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(name));

/** Environment variables: each name with its value. */
export type Environment = Readonly<Record<string, string>>;

/** A function that returns a changed copy of an environment. */
export type EnvironmentTransform = (environment: Environment) => Environment;

/** Returns a transform that removes every credential variable except those named in `allowList`. */
export const removeCredentials =
  (allowList: ReadonlyArray<string> = []): EnvironmentTransform =>
  (environment) =>
    Object.fromEntries(Object.entries(environment).filter(([name]) => allowList.includes(name) || !isCredentialName(name)));

/**
 * Applies `transforms` in order to this process's environment, without the variables that have no
 * value. With no transforms, returns that environment unchanged.
 */
export const processEnvironmentWith = (transforms: ReadonlyArray<EnvironmentTransform>): Environment =>
  transforms.reduce<Environment>((environment, transform) => transform(environment), definedVariables(process.env));

/** Returns the variables in `environment` that have a value. */
const definedVariables = (environment: Readonly<Record<string, string | undefined>>): Environment =>
  Object.fromEntries(Object.entries(environment).flatMap(([name, value]) => (value === undefined ? [] : [[name, value] as const])));

/**
 * Returns `environment` without its credential variables and without the variables that have no
 * value (`env`), and the names of the removed credential variables, sorted (`removed`).
 */
export const withoutCredentials = (
  environment: Readonly<Record<string, string | undefined>>,
): { readonly env: Readonly<Record<string, string>>; readonly removed: ReadonlyArray<string> } => {
  const entries = Object.entries(environment).flatMap(([name, value]) => (value === undefined ? [] : [[name, value] as const]));
  return {
    env: Object.fromEntries(entries.filter(([name]) => !isCredentialName(name))),
    removed: Arr.sort(
      entries.flatMap(([name]) => (isCredentialName(name) ? [name] : [])),
      Order.String,
    ),
  };
};

/** The text that replaces a redacted value in logs and in written configuration. */
export const redactionPlaceholder = "<redacted>";

/**
 * Returns `args` with the value of each credential flag replaced by `redactionPlaceholder`, for logs
 * and written configuration. A credential flag is a flag whose name is a credential name. The value
 * is replaced in both forms:
 * - `--token=ghp_x` becomes `--token=<redacted>`;
 * - in `--api-key sk-y`, the argument `sk-y` becomes `<redacted>`, unless it starts with `-`.
 */
export const redactedArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.map((arg, index) => {
    const joined = /^--?([^=]+)=/.exec(arg);
    if (joined?.[1] !== undefined) return isCredentialName(joined[1]) ? `${arg.slice(0, arg.indexOf("=") + 1)}${redactionPlaceholder}` : arg;
    const before = args[index - 1];
    const flag = before === undefined ? undefined : /^--?([^=]+)$/.exec(before)?.[1];
    return flag !== undefined && isCredentialName(flag) && !arg.startsWith("-") ? redactionPlaceholder : arg;
  });
