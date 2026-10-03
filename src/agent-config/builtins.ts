/**
 * The plug-ins every host has, each over logic built elsewhere:
 *
 * - `loopBreaker` (`agent-policy/loop-breaker.ts`), on `toolCalls` and `modelRequests`: `nudgeAt`
 *   (3), `stopAt` (5), and `key`, what makes two calls identical, by name: `toolAndInput`, the same
 *   tool and the same input as received.
 * - `permissions` (`agent-policy/permissions.ts`), on `toolCalls`: `mode` (`default`). Whether
 *   anyone can be asked is the host's to say (`HostSays.canAsk`).
 * - `maxTurnRequests` (`agent-policy/max-turn-requests.ts`), on `modelRequests`: `limit` (1000).
 * - `retryIncomplete` (`agent-host/incomplete.ts`), on `turnEnd`: `retries` (1).
 */

import { Effect, Schema } from "effect";
import { retryIncomplete as retryIncompleteHook } from "../agent-host/incomplete.ts";
import { loopBreaker as loopBreakerPolicies, permissionsFor, turnRequestLimit } from "../agent-host/services.ts";
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
  toolCalls: permissionsFor(mode, host.canAsk),
}));

export const maxTurnRequests = plugin("maxTurnRequests", Schema.Struct({ limit: defaulted(atLeast(1), defaultMaxTurnRequests) }), ["modelRequests"], ({ limit }) => ({
  modelRequests: turnRequestLimit(limit),
}));

export const retryIncomplete = plugin("retryIncomplete", Schema.Struct({ retries: defaulted(atLeast(0), 1) }), ["turnEnd"], ({ retries }) => ({
  turnEnd: retryIncompleteHook(retries),
}));

export const builtins: ReadonlyArray<AnyPlugin> = [loopBreaker, permissions, maxTurnRequests, retryIncomplete];
