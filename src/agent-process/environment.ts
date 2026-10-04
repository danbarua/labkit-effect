/**
 * The environment a spawned process is given: this process's, without the variables that hold
 * credentials. A variable holds one when a word of its name, its words being what `_`, `-` and `.`
 * separate and where a lower-case letter meets a capital, is one of `credentialWords` (any case): `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`,
 * `AWS_SECRET_ACCESS_KEY` and `SSH_AUTH_SOCK` are left out; `GIT_AUTHOR_NAME` and `PATH` are kept.
 * What a command's own configuration sets (an MCP server's `env`) is given as it says, credentials
 * included: that is how a server is given the one it needs.
 */

export const KNOWN_KEY_PATTERNS = [
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

// A word starts after a separator or at a lower-case to upper-case transition, and ends at a separator or the name's end.
const credentialWord = (word: string): RegExp => {
  const letters = word.split("").map((letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`).join("");
  return new RegExp(`(?:^|[_\\-.]|(?<=[a-z]))${letters}(?=$|[_\\-.])`);
};

export const COMMON_CREDENTIAL_PATTERNS: ReadonlyArray<RegExp> = [
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

/** Whether a variable name or other text content matches known secret patterns. */
export const shouldRedact = (name: string): boolean =>
  COMMON_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(name)) || KNOWN_KEY_PATTERNS.some((pattern) => pattern.test(name));

/** A fancy word for a dictionary of strings. */
export type Environment = Readonly<Record<string, string>>;

/** Applies a transformation to a dictionary of strings (environment). */
export type EnvironmentTransform = (environment: Environment) => Environment;

/** Filters an environment for credential-shaped variables unless asked not to. */
export const credentialsLeftOut =
  (allowList: ReadonlyArray<string> = []): EnvironmentTransform =>
  (environment) =>
    Object.fromEntries(Object.entries(environment).filter(([name]) => allowList.includes(name) || !shouldRedact(name)));

/** `transforms` one after another over this process's environment; with none, it whole. */
export const environmentOf = (transforms: ReadonlyArray<EnvironmentTransform>): Environment =>
  transforms.reduce<Environment>((environment, transform) => transform(environment), definedOf(process.env));

/** The variables of `environment` that have a value. */
const definedOf = (environment: Readonly<Record<string, string | undefined>>): Environment =>
  Object.fromEntries(Object.entries(environment).flatMap(([name, value]) => (value === undefined ? [] : [[name, value] as const])));

/** `environment` without the variables that hold credentials, and the names of those left out. */
export const withoutCredentials = (
  environment: Readonly<Record<string, string | undefined>>,
): { readonly env: Readonly<Record<string, string>>; readonly left: ReadonlyArray<string> } => {
  const entries = Object.entries(environment).flatMap(([name, value]) => (value === undefined ? [] : [[name, value] as const]));
  return {
    env: Object.fromEntries(entries.filter(([name]) => !shouldRedact(name))),
    left: entries.flatMap(([name]) => (shouldRedact(name) ? [name] : [])).sort(),
  };
};

/** What a value left out is written as. */
export const leftOut = "<left out>";

/**
 * `args` as they may be logged or written down: the value of a flag whose name holds a credential is
 * left out, given with the flag (`--token=<left out>`) or as the argument after it (`--api-key`
 * `<left out>`). They are run as given.
 */
export const redactedArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.map((arg, index) => {
    const joined = /^--?([^=]+)=/.exec(arg);
    if (joined?.[1] !== undefined) return shouldRedact(joined[1]) ? `${arg.slice(0, arg.indexOf("=") + 1)}${leftOut}` : arg;
    const before = args[index - 1];
    const flag = before === undefined ? undefined : /^--?([^=]+)$/.exec(before)?.[1];
    return flag !== undefined && shouldRedact(flag) && !arg.startsWith("-") ? leftOut : arg;
  });
