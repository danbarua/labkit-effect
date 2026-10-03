/**
 * The ACP agent as an editor launches it: `bun src/agent-acp/main.ts`, the protocol on stdin and
 * stdout and nothing else on stdout. Its log is a file (`launcher-logs.ts`) whose path it says once
 * on stderr; it exits 0 when stdin closes.
 *
 * Taken from the environment: `LABKIT_ACP_MODEL` (the model sessions start with, `provider/model`),
 * `LABKIT_ACP_LOCAL_TOOLS=1` (the stopgap tools on the local disk), `LABKIT_ACP_PERMISSION_MODE` (the
 * permission mode sessions start in: `default`, `acceptEdits`, `bypassPermissions`, `dontAsk`),
 * `LABKIT_ACP_RETRIES` (how often a turn with thinking and no answer is asked again; 1), `LABKIT_ACP_SESSIONS_DIR` (where
 * sessions are kept, default `~/.labkit/sessions`), the `LABKIT_ACP_LOG_*` variables, and the
 * providers' keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`).
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BunRuntime, BunServices, BunStdio } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import * as Agent from "effective-acp/agent";
import { KeyedAndLocalCatalog } from "../agent-host/catalog.ts";
import { LauncherLogs, launcherLogOptionsFrom } from "../agent-host/launcher-logs.ts";
import { PermissionMode } from "../agent-policy/permissions.ts";
import { hostOptionsFrom, makeHost } from "./host.ts";
import { logKeys } from "./log-keys.ts";

/** Where sessions are kept: `LABKIT_ACP_SESSIONS_DIR`, else `~/.labkit/sessions`. */
export const sessionsDirectoryFrom = (env: Readonly<Record<string, string | undefined>>): string =>
  env["LABKIT_ACP_SESSIONS_DIR"] ? resolve(env["LABKIT_ACP_SESSIONS_DIR"]) : join(homedir(), ".labkit", "sessions");

/** The agent on this process's stdin and stdout, configured from `env`. It returns when stdin closes. */
export const launch = (env: Readonly<Record<string, string | undefined>>) => {
  const options = hostOptionsFrom(env);
  const mode = env["LABKIT_ACP_PERMISSION_MODE"];
  const retries = env["LABKIT_ACP_RETRIES"];
  const unknownMode = Effect.all([
    mode !== undefined && mode !== "" && options.permissionMode === undefined
      ? Effect.logWarning(logKeys.config.permissionModeUnknown, { value: mode, used: "default", modes: PermissionMode.literals })
      : Effect.void,
    retries !== undefined && retries !== "" && options.retries === undefined
      ? Effect.logWarning(logKeys.config.retriesUnknown, { value: retries, used: 1, expected: "a whole number of 0 or more" })
      : Effect.void,
  ]);
  return unknownMode.pipe(
    Effect.andThen(
      Agent.runStdio({
        info: { name: "labkit-effect", version: "0.1.0" },
        implementations: [makeHost({ directory: sessionsDirectoryFrom(env), ...options })],
      }),
    ),
    Effect.provide(Layer.mergeAll(KeyedAndLocalCatalog, LauncherLogs(launcherLogOptionsFrom(env)).pipe(Layer.provideMerge(BunServices.layer)), BunStdio.layer)),
  );
};

if (import.meta.main) launch(process.env).pipe(BunRuntime.runMain);
