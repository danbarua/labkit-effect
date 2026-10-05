/**
 * The launcher (`main.ts`) as an editor runs it: a real subprocess, driven by the official SDK's
 * client over its pipes. No model is asked: the session starts from a draft and nothing is
 * prompted, so the test needs no network and no key that works.
 */

import { expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { test, testFolder } from "../../tests/support/test.ts";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect } from "effect";
import { Command } from "effect/cli";
import { runTest } from "../../tests/support/run.ts";
import { type Brand, defaultBrand } from "../agent-host/brand.ts";
import { launchVariables } from "../agent-host/launch.ts";
import { hostOptionsOf, launchChecked, launcherFlags, type LauncherOptions, sessionsDirectoryOf } from "./main.ts";

const secret = "sk-launcher-test-0123456789";

test("the launcher serves the host on stdin and stdout and nothing else on stdout, keeps its log in a file named once on stderr without the environment's secrets, and exits 0 when stdin closes", async () => {
  const folder = testFolder();
  const logs = join(folder, "logs");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "",
      XAI_API_KEY: "",
      OPENAI_API_KEY: secret,
      LABKIT_ACP_MODEL: "openai/gpt-5.5",
      LABKIT_ACP_LOG_DIR: logs,
      LABKIT_ACP_SESSIONS_DIR: join(folder, "sessions"),
      // The user's file is the test's own, not the machine's.
      HOME: folder,
    },
  });
  const input = new WritableStream<Uint8Array>({
    write: async (chunk) => {
      await child.stdin.write(chunk);
      await child.stdin.flush();
    },
  });
  const [forClient, forTest] = child.stdout.tee();
  const stdout = new Response(forTest).text();
  const stderr = new Response(child.stderr).text();
  const seen = await acp
    .client({ name: "launcher-test" })
    .connectWith(acp.ndJsonStream(input, forClient), async (ctx) => {
      const initialized = await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "launcher-test", version: "0" } });
      const created = await ctx.request("session/new", { cwd: folder, mcpServers: [] });
      const changed = await ctx.request("session/set_config_option", { sessionId: created.sessionId, configId: "effort", value: "high" });
      await ctx.request("session/close", { sessionId: created.sessionId });
      return { initialized, created, changed };
    });
  await child.stdin.end();
  // Bounded by the test's timeout: the launcher must end the process on its own.
  expect(await child.exited).toBe(0);

  expect(seen.initialized.agentInfo).toMatchObject({ name: "labkit", version: "0.1.0" });
  expect(seen.initialized.agentCapabilities?.sessionCapabilities?.close).toBeDefined();
  const current = (options: ReadonlyArray<acp.SessionConfigOption> | null | undefined, id: string) => {
    const option = options?.find((each) => each.id === id);
    return option !== undefined && "currentValue" in option ? option.currentValue : undefined;
  };
  expect(current(seen.created.configOptions, "model")).toBe("openai/gpt-5.5");
  expect(current(seen.changed.configOptions, "effort")).toBe("high");

  const lines = (await stdout).split("\n").filter((line) => line !== "");
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.every((line) => JSON.parse(line).jsonrpc === "2.0")).toBe(true);

  const files = readdirSync(logs).filter((name) => /^acp-\d+-.+\.jsonl$/.test(name));
  expect(files).toHaveLength(1);
  const text = await stderr;
  expect(text.match(/ACP log: /g)).toHaveLength(1);
  expect(text).toContain(join(logs, files[0] ?? ""));
  const log = readFileSync(join(logs, files[0] ?? ""), "utf8");
  expect(log).toContain("acp_host.session.created");
  expect(log).not.toContain(secret);
  expect(text).not.toContain(secret);
  // A draft that was never prompted leaves no session on disk.
  expect(existsSync(join(folder, "sessions"))).toBe(false);
});

/** The launcher's options `args` and `env` give, as `brand`, read as the launcher reads them (its variables: the brand's prefix and ACP_). */
const launcherOptions = (args: ReadonlyArray<string>, env: Readonly<Record<string, string>>, brand: Brand = defaultBrand) => {
  let seen: LauncherOptions | undefined;
  const command = Command.make("launched", launcherFlags, (options) =>
    Effect.sync(() => {
      seen = options;
    }),
  );
  return runTest(
    Command.runWith(command, { version: "0" })(args).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, launchVariables(brand, ["ACP"], env)),
      Effect.provide(BunServices.layer),
      Effect.ignore,
    ),
  ).then(() => seen);
};

/** Whether what of a session's configuration no folder changes can be used with `options`; the problem when it cannot. */
const checked = (options: LauncherOptions) =>
  runTest(
    launchChecked(options, defaultBrand, join(testFolder(), "home")).pipe(
      Effect.map(() => "usable"),
      Effect.catchTag("ConfigInvalid", (error) => Effect.succeed(error.message)),
      Effect.provide(BunServices.layer),
    ),
  );

test("--retries (LABKIT_ACP_RETRIES) is how many times a turn with thinking and no answer is asked again; one that is not a whole number of 0 or more ends the launch", async () => {
  expect((await launcherOptions([], { LABKIT_ACP_RETRIES: "2" }))?.retries).toBe(2);
  expect((await launcherOptions(["--retries", "0"], { LABKIT_ACP_RETRIES: "2" }))?.retries).toBe(0);
  expect((await launcherOptions([], {}))?.retries).toBeUndefined();
  expect(await launcherOptions([], { LABKIT_ACP_RETRIES: "two" })).toBeUndefined();
  const minusOne = await launcherOptions([], { LABKIT_ACP_RETRIES: "-1" });
  expect(minusOne?.retries).toBe(-1);
  expect(await checked(minusOne!)).toBe('the ACP host\'s defaults: plugins.retryIncomplete.retries: Expected a value greater than or equal to 0 at ["retries"]');
});

test("sessions are kept in --sessions-dir (LABKIT_ACP_SESSIONS_DIR), else in ~/.labkit/sessions; for another brand, its variable and folder", async () => {
  const acme = { name: "acme", version: "1.0.0" };
  expect(sessionsDirectoryOf(undefined, defaultBrand)).toBe(join(homedir(), ".labkit", "sessions"));
  expect(sessionsDirectoryOf(undefined, acme)).toBe(join(homedir(), ".acme", "sessions"));
  const directory = async (env: Readonly<Record<string, string>>, brand: Brand = defaultBrand, args: ReadonlyArray<string> = []) =>
    hostOptionsOf((await launcherOptions(args, env, brand))!, brand).directory;
  expect(await directory({ LABKIT_ACP_SESSIONS_DIR: "" })).toBe(join(homedir(), ".labkit", "sessions"));
  expect(await directory({ LABKIT_ACP_SESSIONS_DIR: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
  expect(await directory({ LABKIT_ACP_SESSIONS_DIR: "/tmp/elsewhere" }, defaultBrand, ["--sessions-dir", "/tmp/given"])).toBe("/tmp/given");
  expect(await directory({ LABKIT_ACP_SESSIONS_DIR: "/tmp/elsewhere" }, acme)).toBe(join(homedir(), ".acme", "sessions"));
  expect(await directory({ ACME_ACP_SESSIONS_DIR: "/tmp/acme" }, acme)).toBe("/tmp/acme");
});

test("the launcher's options are the brand's variables, and no other brand's", async () => {
  const acme = { name: "acme", version: "1.0.0" };
  const env = { ACME_ACP_MODEL: "openai/gpt-5.5", ACME_ACP_RETRIES: "3", ACME_ACP_PERMISSION_MODE: "acceptEdits", ACME_ACP_LOCAL_TOOLS: "1", LABKIT_ACP_RETRIES: "9" };
  const asAcme = hostOptionsOf((await launcherOptions([], env, acme))!, acme);
  expect(asAcme).toMatchObject({ model: "openai/gpt-5.5", world: "local", retries: 3, strictToolInput: false, brand: acme, configFlags: { permissionMode: "acceptEdits" } });
  expect(hostOptionsOf((await launcherOptions([], env))!, defaultBrand)).toMatchObject({ model: undefined, world: "editor", retries: 9, configFlags: { permissionMode: undefined } });
});

test("the launcher refuses to start when an option cannot be used: said on stderr, nothing on stdout, exit code 1", async () => {
  const folder = testFolder();
  const launched = async (env: Readonly<Record<string, string>>) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LABKIT_ACP_LOG_DIR: join(folder, "logs"), LABKIT_ACP_SESSIONS_DIR: join(folder, "sessions"), HOME: folder, ...env },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  const zero = await launched({ LABKIT_ACP_MAX_TURNS: "0" });
  expect(zero.code).toBe(1);
  expect(zero.stdout).toBe("");
  expect(zero.stderr).toContain('The configuration cannot be used: the command line: plugins.maxTurnRequests.limit: Expected a value greater than or equal to 1 at ["limit"]');
  const mode = await launched({ LABKIT_ACP_PERMISSION_MODE: "yolo" });
  expect(mode.code).toBe(1);
  expect(mode.stdout).toBe("");
  expect(mode.stderr).toContain("--permission-mode");
});
