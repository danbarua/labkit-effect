/**
 * The plug-ins every host has, each over logic built elsewhere:
 *
 * - `loopBreaker` (`agent-policy/loop-breaker.ts`), on `toolCalls` and `modelRequests`: `nudgeAt`
 *   (3), `stopAt` (5), and `key`, what makes two calls identical, by name: `toolAndInput`, the same
 *   tool and the same input as received.
 * - `permissions` (`agent-policy/permissions.ts`), on `toolCalls`: `mode` (`default`). Whether
 *   anyone can be asked is the host's to say (`HostSays.canAsk`); where the user changes the mode
 *   during a session, the mode it follows is the host's too (`HostSays.permissionMode`), and `mode`
 *   is the one the session starts in.
 * - `maxTurnRequests` (`agent-policy/max-turn-requests.ts`), on `modelRequests`: `limit` (1000).
 * - `retryIncomplete` (`agent-host/incomplete.ts`), on `turnEnd`: `retries` (1).
 * - `maxBudget` (`agent-host/services.ts`), on `modelRequests`: `usd`, which it has no default for:
 *   a model request once the session has cost that much is vetoed.
 * - `credentials` (`agent-process/environment.ts`), on `commandEnvironment`: `pass` (none), the
 *   variables a command the model runs is given although they hold credentials (`SSH_AUTH_SOCK`,
 *   for `git push` over SSH); the others are left out.
 */

import { credentialsLeftOut } from "../agent-process/environment.ts";
import { Effect, Schema } from "effect";
import { retryIncomplete as retryIncompleteHook } from "../agent-host/incomplete.ts";
import { budgetLimit, loopBreaker as loopBreakerPolicies, permissionsFor, turnRequestLimit } from "../agent-host/services.ts";
import { type CallKey, sameToolAndInput } from "../agent-policy/loop-breaker.ts";
import { defaultMaxTurnRequests } from "../agent-policy/max-turn-requests.ts";
import { PermissionMode } from "../agent-policy/permissions.ts";
import type { ToolName } from "../agent-machine/names.ts";
import type { Received } from "../agent-machine/received.ts";
import { type AnyPlugin, plugin } from "./plugin.ts";

/** A setting `schema` takes, `value` when the file does not say. */
const defaulted = <S extends Schema.Top>(schema: S, value: S["Encoded"]) => schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));

const atLeast = (minimum: number) => Schema.Int.check(Schema.isGreaterThanOrEqualTo(minimum));

/** The ways of telling identical calls apart, by the name a file gives them. */
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

export const permissions = plugin("permissions", Schema.Struct({ mode: defaulted(PermissionMode, "default") }), ["toolCalls"], ({ mode }, host) => ({
  toolCalls: permissionsFor(host.permissionMode ?? mode, host.canAsk),
}));

export const maxTurnRequests = plugin("maxTurnRequests", Schema.Struct({ limit: defaulted(atLeast(1), defaultMaxTurnRequests) }), ["modelRequests"], ({ limit }) => ({
  modelRequests: turnRequestLimit(limit),
}));

export const retryIncomplete = plugin("retryIncomplete", Schema.Struct({ retries: defaulted(atLeast(0), 1) }), ["turnEnd"], ({ retries }) => ({
  turnEnd: retryIncompleteHook(retries),
}));

export const maxBudget = plugin("maxBudget", Schema.Struct({ usd: Schema.Number.check(Schema.isGreaterThan(0)) }), ["modelRequests"], ({ usd }) => ({
  modelRequests: budgetLimit(usd),
}));

export const credentials = plugin("credentials", Schema.Struct({ pass: defaulted(Schema.Array(Schema.String), []) }), ["commandEnvironment"], ({ pass }) => ({
  commandEnvironment: credentialsLeftOut(pass),
}));

export const builtins: ReadonlyArray<AnyPlugin> = [loopBreaker, permissions, maxTurnRequests, retryIncomplete, maxBudget, credentials];
