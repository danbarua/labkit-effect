/**
 * The environment a spawned process is given: this process's, without the variables that hold
 * credentials. A variable holds one when a word of its name, its words being what `_`, `-` and `.`
 * separate and where a lower-case letter meets a capital, is one of `credentialWords` (any case): `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`,
 * `AWS_SECRET_ACCESS_KEY` and `SSH_AUTH_SOCK` are left out; `GIT_AUTHOR_NAME` and `PATH` are kept.
 * What a command's own configuration sets (an MCP server's `env`) is given as it says, credentials
 * included: that is how a server is given the one it needs.
 */

/** The words of a variable's name that say it holds a credential. */
export const credentialWords: ReadonlyArray<string> = [
  "TOKEN",
  "TOKENS",
  "KEY",
  "KEYS",
  "APIKEY",
  "AUTH",
  "SECRET",
  "SECRETS",
  "PASSWORD",
  "PASSWORDS",
  "PASSWD",
  "PASS",
  "PASSPHRASE",
  "CREDENTIAL",
  "CREDENTIALS",
  "CREDS",
  "COOKIE",
  "COOKIES",
  "PAT",
];

/** The words of a name: what `_`, `-` and `.` separate, and a lower-case letter followed by a capital (`authToken`). */
const wordsOf = (name: string): ReadonlyArray<string> =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[_.-]/);

/** Whether the variable `name` holds a credential. */
export const isCredential = (name: string): boolean => wordsOf(name).some((word) => credentialWords.includes(word));

/** `environment` without the variables that hold credentials, and the names of those left out. */
export const withoutCredentials = (
  environment: Readonly<Record<string, string | undefined>>,
): { readonly env: Readonly<Record<string, string>>; readonly left: ReadonlyArray<string> } => {
  const entries = Object.entries(environment).flatMap(([name, value]) => (value === undefined ? [] : [[name, value] as const]));
  return {
    env: Object.fromEntries(entries.filter(([name]) => !isCredential(name))),
    left: entries.flatMap(([name]) => (isCredential(name) ? [name] : [])).sort(),
  };
};
