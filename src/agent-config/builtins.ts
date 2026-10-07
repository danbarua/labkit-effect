/**
 * The plug-ins that every host has, each over logic built elsewhere. Defaults are in parentheses.
 *
 * - `loopBreaker` (`agent-policy/loop-breaker.ts`), on `toolCalls` and `modelRequests`: `nudgeAt`
 *   (3), `stopAt` (5), and `key`, the name of what makes two calls identical (`toolAndInput`: the
 *   same tool and the same input as received).
 * - `permissions` (`agent-policy/permissions.ts`), on `toolCalls`: `mode` (`default`). The host says
 *   whether anyone can be asked (`FromHost.canAsk`). Where the user changes the mode during a
 *   session, the entry follows the host's mode (`FromHost.permissionMode`), and `mode` is the mode
 *   that the session starts in.
 * - `maxTurnRequests` (`agent-policy/max-turn-requests.ts`), on `modelRequests`: `limit` (1000).
 * - `retryIncomplete` (`agent-host/incomplete.ts`), on `turnEnd`: `retries` (1).
 * - `maxBudget` (`agent-host/services.ts`), on `modelRequests`: `usd`, with no default. A model
 *   request is vetoed once the session has cost that much.
 * - `credentials` (`agent-process/environment.ts`), on `commandEnvironment`: `pass` (none), the
 *   credential variables that the model's commands still receive (`SSH_AUTH_SOCK`, for `git push`
 *   over SSH). The other credential variables are removed.
 */

import { removeCredentials } from "../agent-process/environment.ts";
import { Effect, Schema } from "effect";
import { retryIncomplete as retryIncompleteHook } from "../agent-host/incomplete.ts";
import { budgetLimit, loopBreaker as loopBreakerPolicies, permissionsFor, turnRequestLimit } from "../agent-host/services.ts";
import { type CallKey, sameToolAndInput } from "../agent-policy/loop-breaker.ts";
import { defaultMaxTurnRequests } from "../agent-policy/max-turn-requests.ts";
import { defaultPermissionSettings, PermissionMode } from "../agent-policy/permissions.ts";
import type { Configuration } from "./file.ts";
import { PermissionRule, ReadOnlyPrefix } from "../agent-policy/permission-rules.ts";
import { ToolName } from "../agent-machine/names.ts";
import type { Received } from "../agent-machine/received.ts";
import { type AnyPlugin, plugin } from "./plugin.ts";

/** A setting of type `schema`, which takes `value` when the file does not give it. */
const defaulted = <S extends Schema.Top>(schema: S, value: S["Encoded"]) => schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));

const atLeast = (minimum: number) => Schema.Int.check(Schema.isGreaterThanOrEqualTo(minimum));

/** The ways of telling identical calls apart, by the name that a file uses for each. */
const keys: Readonly<Record<"toolAndInput", (tool: ToolName, input: Received) => CallKey>> = { toolAndInput: sameToolAndInput };

export const loopBreaker = plugin(
  "loopBreaker",
  Schema.Struct({
    nudgeAt: defaulted(atLeast(1), 3),
    stopAt: defaulted(atLeast(1), 5),
    key: defaulted(Schema.Literals(["toolAndInput"]), "toolAndInput"),
  }),
  ["toolCalls", "modelRequests"],
  ({ nudgeAt, stopAt, key }) => loopBreakerPolicies({ nudgeAt, stopAt, key: keys[key] }),
);

/**
 * The permission policy (`agent-policy/permissions.ts`): its mode; its allow and deny rules
 * (`<tool>`, `<tool>(<words>)`, `<tool>(<words>:*)`, with `command` for every command tool, and the
 * path rules `Read(<path>)` and `Edit(<path>)`); the read-only programs that command tools run without
 * a question; which tools run shell commands; and the additional folders that count as inside the
 * working folder (`additionalDirectories`: absolute, from `~`, or relative to the working folder),
 * with those the host adds for the session.
 */
export const permissions = plugin(
  "permissions",
  Schema.Struct({
    mode: defaulted(PermissionMode, "default"),
    allow: defaulted(Schema.Array(PermissionRule), []),
    deny: defaulted(Schema.Array(PermissionRule), []),
    readOnly: defaulted(Schema.Array(ReadOnlyPrefix), defaultPermissionSettings.readOnly),
    commandTools: defaulted(Schema.Array(ToolName), defaultPermissionSettings.commandTools),
    additionalDirectories: defaulted(Schema.Array(Schema.String), []),
  }),
  ["toolCalls"],
  ({ mode, additionalDirectories, ...settings }, host) => ({
    toolCalls: permissionsFor(host.permissionMode ?? mode, host.canAsk, settings, host.workingFolder, [...additionalDirectories, ...(host.additionalFolders ?? [])]),
  }),
);

/** The folders that `configuration`'s permissions plug-in counts as inside the working folder (`additionalDirectories`), as written. */
export const additionalDirectoriesOf = (configuration: Configuration): ReadonlyArray<string> =>
  (configuration.lists.toolCalls ?? []).flatMap((entry) => {
    const settings: unknown = entry.settings;
    if (entry.plugin.use !== permissions.use || typeof settings !== "object" || settings === null || !("additionalDirectories" in settings) || !Array.isArray(settings.additionalDirectories)) return [];
    return settings.additionalDirectories.filter((folder): folder is string => typeof folder === "string");
  });

export const maxTurnRequests = plugin("maxTurnRequests", Schema.Struct({ limit: defaulted(atLeast(1), defaultMaxTurnRequests) }), ["modelRequests"], ({ limit }) => ({
  modelRequests: turnRequestLimit(limit),
}));

export const retryIncomplete = plugin("retryIncomplete", Schema.Struct({ retries: defaulted(atLeast(0), 1) }), ["turnEnd"], ({ retries }) => ({
  turnEnd: retryIncompleteHook(retries),
}));

export const maxBudget = plugin("maxBudget", Schema.Struct({ usd: Schema.Finite.check(Schema.isGreaterThan(0)) }), ["modelRequests"], ({ usd }) => ({
  modelRequests: budgetLimit(usd),
}));

export const credentials = plugin("credentials", Schema.Struct({ pass: defaulted(Schema.Array(Schema.String), []) }), ["commandEnvironment"], ({ pass }) => ({
  commandEnvironment: removeCredentials(pass),
}));

export const builtins: ReadonlyArray<AnyPlugin> = [loopBreaker, permissions, maxTurnRequests, retryIncomplete, maxBudget, credentials];
