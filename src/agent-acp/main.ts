/**
 * The ACP agent as an editor launches it: `bun src/agent-acp/main.ts`, the protocol on stdin and
 * stdout and nothing else on stdout. Its log is a file (`launcher-logs.ts`) whose path it says once
 * on stderr; it exits 0 when stdin closes.
 *
 * It runs as the brand `launch` is given, else the one the environment names (`LABKIT_BRAND`), else
 * labkit (`agent-host/brand.ts`). Taken from the environment, each name after the brand's prefix
 * (`LABKIT_` for labkit's): `ACP_MODEL` (the model sessions start with, `provider/model`),
 * `ACP_LOCAL_TOOLS=1` (the stopgap tools on the local disk), `ACP_PERMISSION_MODE` (the permission
 * mode sessions start in: `default`, `acceptEdits`, `bypassPermissions`, `dontAsk`), `ACP_RETRIES`
 * (how often a turn with thinking and no answer is asked again; 1), `ACP_STRICT_TOOL_INPUT=1` (refuse
 * a tool call with input properties its tool does not take; without it, the call runs without them
 * and says so), `ACP_SESSIONS_DIR` (where sessions are kept, default `~/.<brand>/sessions`), the
 * `ACP_LOG_*` variables; and the providers' keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
 * `XAI_API_KEY`).
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BunRuntime, BunServices, BunStdio } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import * as Agent from "effective-acp/agent";
import { KeyedAndLocalCatalog } from "../agent-host/catalog.ts";
import { type Brand, brandFrom, envPrefixOf, folderOf } from "../agent-host/brand.ts";
import { LauncherLogs, launcherLogOptionsFrom } from "../agent-host/launcher-logs.ts";
import { PermissionMode } from "../agent-policy/permissions.ts";
import { hostOptionsFrom, makeHost } from "./host.ts";
import { logKeys } from "./log-keys.ts";

/** Where sessions are kept: `<PREFIX>ACP_SESSIONS_DIR`, else `~/.<brand>/sessions`. */
export const sessionsDirectoryFrom = (env: Readonly<Record<string, string | undefined>>, brand: Brand = brandFrom(env)): string => {
  const named = env[`${envPrefixOf(brand)}ACP_SESSIONS_DIR`];
  return named ? resolve(named) : join(homedir(), folderOf(brand), "sessions");
};

/**
 * The agent on this process's stdin and stdout, configured from `env`, as `brand` (the one `env`
 * names, else the default, unless a program gives one). It returns when stdin closes.
 */
export const launch = (env: Readonly<Record<string, string | undefined>>, brand: Brand = brandFrom(env)) => {
  const options = hostOptionsFrom(env, brand);
  const mode = env[`${envPrefixOf(brand)}ACP_PERMISSION_MODE`];
  const retries = env[`${envPrefixOf(brand)}ACP_RETRIES`];
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
        info: { name: brand.name, version: brand.version },
        implementations: [makeHost({ directory: sessionsDirectoryFrom(env, brand), ...options })],
      }),
    ),
    Effect.provide(Layer.mergeAll(KeyedAndLocalCatalog, LauncherLogs(launcherLogOptionsFrom(env, brand)).pipe(Layer.provideMerge(BunServices.layer)), BunStdio.layer)),
  );
};

if (import.meta.main) launch(process.env).pipe(BunRuntime.runMain);
