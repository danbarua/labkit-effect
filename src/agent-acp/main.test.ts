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
import { hostOptionsFrom } from "./host.ts";
import { sessionsDirectoryFrom } from "./main.ts";

const secret = "sk-launcher-test-0123456789";

test("AG14: the launcher serves the host on stdin and stdout and nothing else on stdout, keeps its log in a file named once on stderr without the environment's secrets, and exits 0 when stdin closes", async () => {
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

test("AG16: LABKIT_ACP_RETRIES is how many times a turn with thinking and no answer is asked again; anything but a whole number of 0 or more is left out", () => {
  expect(hostOptionsFrom({ LABKIT_ACP_RETRIES: "2" }).retries).toBe(2);
  expect(hostOptionsFrom({ LABKIT_ACP_RETRIES: "0" }).retries).toBe(0);
  expect(hostOptionsFrom({ LABKIT_ACP_RETRIES: "-1" }).retries).toBeUndefined();
  expect(hostOptionsFrom({ LABKIT_ACP_RETRIES: "two" }).retries).toBeUndefined();
  expect(hostOptionsFrom({}).retries).toBeUndefined();
});

test("AG15: sessions are kept in LABKIT_ACP_SESSIONS_DIR, else in ~/.labkit/sessions; for another brand, its variable and folder", () => {
  expect(sessionsDirectoryFrom({})).toBe(join(homedir(), ".labkit", "sessions"));
  expect(sessionsDirectoryFrom({ LABKIT_ACP_SESSIONS_DIR: "" })).toBe(join(homedir(), ".labkit", "sessions"));
  expect(sessionsDirectoryFrom({ LABKIT_ACP_SESSIONS_DIR: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
  const acme = { name: "acme", version: "1.0.0" };
  expect(sessionsDirectoryFrom({ LABKIT_ACP_SESSIONS_DIR: "/tmp/elsewhere" }, acme)).toBe(join(homedir(), ".acme", "sessions"));
  expect(sessionsDirectoryFrom({ ACME_ACP_SESSIONS_DIR: "/tmp/acme" }, acme)).toBe("/tmp/acme");
  expect(sessionsDirectoryFrom({ LABKIT_BRAND: "acme", ACME_ACP_SESSIONS_DIR: "/tmp/acme" })).toBe("/tmp/acme");
});

test("AG24: the launcher's options are the brand's variables, and no other brand's", () => {
  const acme = { name: "acme", version: "1.0.0" };
  const env = { ACME_ACP_MODEL: "openai/gpt-5.5", ACME_ACP_RETRIES: "3", ACME_ACP_PERMISSION_MODE: "acceptEdits", ACME_ACP_LOCAL_TOOLS: "1", LABKIT_ACP_RETRIES: "9" };
  expect(hostOptionsFrom(env, acme)).toEqual({ model: "openai/gpt-5.5", world: "local", permissionMode: "acceptEdits", retries: 3, strictToolInput: false, brand: acme });
  expect(hostOptionsFrom(env)).toMatchObject({ model: undefined, world: "editor", permissionMode: undefined, retries: 9 });
  expect(hostOptionsFrom({ ...env, LABKIT_BRAND: "acme" })).toMatchObject({ model: "openai/gpt-5.5", retries: 3, brand: { name: "acme" } });
});
