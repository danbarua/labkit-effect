/**
 * A few methods of an ACP agent on the peer, for `peer.test.ts` and the stdio entry beside it; enough
 * for the official ACP SDK's client to drive. The prompt's text says what the turn does:
 * - `permission`: asks the client for permission, then reports the answer. The turn ends `cancelled`
 *   when the answer is `cancelled` or the question was cancelled (-32800), as an ACP client answers
 *   after `session/cancel`; and when `session/cancel` arrives while the agent still waits, the
 *   question is cancelled (`$/cancel_request`).
 * - `acknowledge`: asks the client for `_test/acknowledge`, whose success is an object with only
 *   optional fields, then reports the answer.
 * - `hang`: waits until it is interrupted.
 * - `fail`: fails with a JSON-RPC error of its own.
 * - `refuse`: fails with `Refused`, a tagged error class shaped like a JSON-RPC error, with a field
 *   of its own.
 * - `die`: dies.
 * - anything else: ends the turn.
 *
 * Every turn first sends one `session/update`.
 */

import { Data, Deferred, Effect, Option, Schema, type Scope } from "effect";
import type { Wire } from "./json-rpc.ts";
import * as Methods from "./methods.ts";
import * as Peer from "./peer.ts";

/** A domain error a handler fails with: a JSON-RPC error by shape, with a tag and a field of its own. */
class Refused extends Data.TaggedError("Refused")<{ readonly code: number; readonly message: string; readonly reason: string }> {}

const SessionId = Schema.String;

const StopReason = Schema.Literals(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]);

const PermissionOption = Schema.Struct({
  optionId: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["allow_once", "allow_always", "reject_once", "reject_always"]),
});

const PermissionOutcome = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("selected"), optionId: Schema.String }),
  Schema.Struct({ outcome: Schema.Literal("cancelled") }),
]);

/** What the agent serves. */
export const AgentMethods = Methods.make(
  Methods.request(
    "initialize",
    Schema.Struct({ protocolVersion: Schema.Finite }),
    Schema.Struct({
      protocolVersion: Schema.Finite,
      agentCapabilities: Schema.Struct({ loadSession: Schema.Boolean }),
      authMethods: Schema.Array(Schema.Unknown),
    }),
  ),
  Methods.request("session/new", Schema.Struct({ cwd: Schema.String }), Schema.Struct({ sessionId: SessionId })),
  Methods.request(
    "session/prompt",
    Schema.Struct({
      sessionId: SessionId,
      prompt: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
    }),
    Schema.Struct({ stopReason: StopReason }),
  ),
  Methods.notification("session/cancel", Schema.Struct({ sessionId: SessionId })),
);

/** What the agent asks of the client. */
export const ClientMethods = Methods.make(
  Methods.request(
    "session/request_permission",
    Schema.Struct({
      sessionId: SessionId,
      toolCall: Schema.Struct({ toolCallId: Schema.String, title: Schema.String }),
      options: Schema.Array(PermissionOption),
    }),
    Schema.Struct({ outcome: PermissionOutcome }),
  ),
  Methods.request("_test/acknowledge", Schema.Struct({ sessionId: SessionId }), Schema.Struct({ note: Schema.optionalKey(Schema.String) })),
);

/** What the agent tells the client. */
export const ClientNotifications = Methods.make(
  Methods.notification("session/update", Schema.Struct({ sessionId: SessionId, update: Schema.Unknown })),
);

/** The agent's end of the connection. */
export type AgentPeer = Peer.Peer<Methods.Of<typeof ClientMethods>, Methods.Of<typeof ClientNotifications>>;

/** What a test can watch of the agent from outside. */
export interface Probe {
  /** Completed when a `hang` turn's handler is interrupted. */
  readonly hangInterrupted: Deferred.Deferred<void>;
  /** Completed when a `hang` turn's handler starts. */
  readonly hanging: Deferred.Deferred<void>;
}

const text = (sessionId: string, words: string) => ({
  sessionId,
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: words } },
});

export const permissionRequest = (sessionId: string) => ({
  sessionId,
  toolCall: { toolCallId: "call-1", title: "write_file" },
  options: [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" as const },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" as const },
  ],
});

/** Runs the agent on `wire` until the wire's read ends or the scope closes. */
export const runAgent = (wire: Wire, probe: Probe): Effect.Effect<AgentPeer, never, Scope.Scope> => {
  const cancels = new Map<string, Deferred.Deferred<void>>();
  let sessions = 0;
  return Peer.make({
    wire,
    serve: AgentMethods,
    call: ClientMethods,
    notify: ClientNotifications,
    handlers: (peer) =>
      Effect.succeed({
        initialize: () =>
          Effect.succeed({ protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] }),
        "session/new": () => Effect.succeed({ sessionId: `session-${++sessions}` }),
        "session/cancel": ({ sessionId }) => {
          const cancel = cancels.get(sessionId);
          return cancel === undefined ? Effect.void : Deferred.succeed(cancel, undefined).pipe(Effect.asVoid);
        },
        "session/prompt": ({ sessionId, prompt }) =>
          Effect.gen(function* () {
            const cancelled = yield* Deferred.make<void>();
            cancels.set(sessionId, cancelled);
            yield* peer.notify("session/update", text(sessionId, "Working."));
            switch (prompt.map((block) => block.text ?? "").join("")) {
              case "permission": {
                const answer = yield* Effect.raceFirst(
                  peer.client["session/request_permission"](permissionRequest(sessionId)).pipe(
                    Effect.map(({ outcome }) => (outcome.outcome === "cancelled" ? Option.none() : Option.some(outcome))),
                    Effect.catchIf(
                      (error) => "code" in error && error.code === -32800,
                      () => Effect.succeedNone,
                    ),
                  ),
                  Deferred.await(cancelled).pipe(Effect.as(Option.none())),
                );
                if (Option.isNone(answer)) return { stopReason: "cancelled" as const };
                yield* peer.notify("session/update", text(sessionId, `Answered: ${JSON.stringify(answer.value)}`));
                return { stopReason: "end_turn" as const };
              }
              case "acknowledge": {
                const answer = yield* peer.client["_test/acknowledge"]({ sessionId });
                yield* peer.notify("session/update", text(sessionId, `Acknowledged: ${JSON.stringify(answer)}`));
                return { stopReason: "end_turn" as const };
              }
              case "hang":
                return yield* Deferred.succeed(probe.hanging, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(probe.hangInterrupted, undefined)),
                );
              case "fail":
                return yield* Effect.fail({ code: -32042, message: "Refused by the test agent", data: { asked: "fail" } });
              case "refuse":
                return yield* new Refused({ code: -32042, message: "Refused by the test agent", reason: "tagged" });
              case "die":
                return yield* Effect.die(new Error("the test agent's handler died"));
              default:
                return { stopReason: "end_turn" as const };
            }
          }).pipe(
            Effect.mapError((error) => ("code" in error ? error : { code: -32603, message: "Internal error" })),
            Effect.ensuring(Effect.sync(() => cancels.delete(sessionId))),
          ),
      }),
  });
};
