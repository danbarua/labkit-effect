/** Credential name classification, argument redaction, and the environment that a run receives and logs. */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect, Layer, Logger, Stream } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { shouldRedact, redactedArgs, withoutCredentials } from "./environment.ts";
import { logKeys } from "./log-keys.ts";
import { makeProcessGroup, type ProcessCommand } from "./process-group.ts";

test("a name whose words include a credential word is a credential name, and withoutCredentials removes those variables and returns their names in order", () => {
  const held = ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "SSH_AUTH_SOCK", "npm_config__authToken", "DB_PASSWORD", "GH_PAT", "my.secret", "OPENAI_APIKEY"];
  for (const h of held) {
    expect(shouldRedact(h), `"${h} should be redacted`).toBeTrue();
  }

  const kept = ["PATH", "HOME", "GIT_AUTHOR_NAME", "KEYBOARD_LAYOUT", "MONKEY", "PATTERN", "LANG", "MAX_TOKENS"];
  for (const k of kept) {
    expect(shouldRedact(k), `"${k}" should not be redacted`).toBeFalse();
  }

  expect(withoutCredentials({ PATH: "/bin", GITHUB_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", EMPTY: undefined })).toEqual({ env: { PATH: "/bin" }, left: ["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"] });
});

test("in a camelCase name, a credential word counts only where a capital after a lower-case letter starts and ends it: apiKeyId is a credential name, monkey is not", () => {
  const held = ["apiKeyId", "githubTokenValue", "passwordHash", "myPAT", "XApiKey", "authToken"];
  for (const h of held) {
    expect(shouldRedact(h), `"${h}" should be redacted`).toBeTrue();
  }
  const kept = ["monkey", "bypass", "compass", "turkey", "keyboard", "tokenizer", "pathToFile"];
  for (const k of kept) {
    expect(shouldRedact(k), `"${k}" should not be redacted`).toBeFalse();
  }
});

test("redactedArgs replaces the value of a credential flag, given as --flag=value or as the next argument, and leaves other arguments unchanged", () => {
  expect(redactedArgs(["stdio", "--token=ghp_x", "--api-key", "sk-y", "--read-only", "--port", "8080", "--auth-token", "--verbose"])).toEqual([
    "stdio",
    "--token=<redacted>",
    "--api-key",
    "<redacted>",
    "--read-only",
    "--port",
    "8080",
    "--auth-token",
    "--verbose",
  ]);
});

test("a run receives this process's environment without its credential variables, plus the variables that its command sets, credentials included", async () => {
  process.env["LABKIT_TEST_TOKEN"] = "inherited";
  process.env["LABKIT_TEST_PLAIN"] = "plain";
  const printed = await runTest(
    Effect.gen(function* () {
      const output = yield* Deferred.make<string>();
      const group = yield* makeProcessGroup(
        { name: "env", command: "/bin/sh", args: ["-c", "env"], env: { SERVER_TOKEN: "given" } },
        (_run, handle) => handle.stdout.pipe(Stream.decodeText, Stream.mkString, Effect.flatMap((text) => Deferred.succeed(output, text)), Effect.ignore),
      );
      yield* group.start;
      return yield* Deferred.await(output).pipe(Effect.timeout("5 seconds"));
    }).pipe(Effect.provide(BunServices.layer)),
  );
  const names = printed.split("\n").map((line) => line.split("=")[0]);
  expect(names).toContain("LABKIT_TEST_PLAIN");
  expect(names).not.toContain("LABKIT_TEST_TOKEN");
  expect(printed).toContain("SERVER_TOKEN=given");
});

/** Starts one run of `command` and returns what the run printed, the details of each log event with a given key, and every log message as JSON text. */
const loggedBy = (command: ProcessCommand) =>
  Effect.gen(function* () {
    const logged: Array<unknown> = [];
    const logging = Logger.layer([Logger.make((options) => logged.push(options.message))], { mergeWithExisting: true });
    const printed = yield* Effect.gen(function* () {
      const output = yield* Deferred.make<string>();
      const group = yield* makeProcessGroup(command, (_run, handle) => handle.stdout.pipe(Stream.decodeText, Stream.mkString, Effect.flatMap((text) => Deferred.succeed(output, text)), Effect.ignore));
      yield* group.start;
      return yield* Deferred.await(output).pipe(Effect.timeout("5 seconds"));
    }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, logging)));
    const details = (key: string) => logged.flatMap((message) => (Array.isArray(message) && message[0] === key ? [message[1] as Record<string, unknown>] : []));
    return { printed, details, text: JSON.stringify(logged) };
  });

test("a run's arguments are logged with each credential flag's value redacted, and the process receives the original values", async () => {
  const { printed, details } = await runTest(loggedBy({ name: "args", command: "/bin/sh", args: ["-c", 'printf "%s" "$0"', "--token=ghp_secret"], env: {} }));
  expect(printed).toBe("--token=ghp_secret");
  const changes = details(logKeys.process.changed);
  expect(changes.length).toBeGreaterThan(0);
  for (const change of changes) expect(change["args"]).toEqual(["-c", 'printf "%s" "$0"', "--token=<redacted>"]);
});

test("a run's environment is logged by variable names only: the credential variables removed, and the variables the command sets", async () => {
  process.env["LABKIT_TEST_LOGGED_TOKEN"] = "inherited-value";
  const { details, text } = await runTest(loggedBy({ name: "env", command: "/bin/sh", args: ["-c", "exit 0"], env: { SERVER_TOKEN: "given-value" } }));
  expect(details(logKeys.process.environment)).toMatchObject([{ name: "env", run: 1, leftOut: expect.arrayContaining(["LABKIT_TEST_LOGGED_TOKEN"]), set: ["SERVER_TOKEN"] }]);
  expect(text).not.toContain("inherited-value");
  expect(text).not.toContain("given-value");
});
