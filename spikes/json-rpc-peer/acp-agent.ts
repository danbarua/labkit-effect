/**
 * SPIKE: a few methods of an ACP agent on the two-way peer, enough to be driven by the official ACP
 * SDK. The prompt's text says what the turn does:
 * - `permission`: asks the client for permission, then reports the answer. The turn ends
 *   `cancelled` when the answer is `cancelled` or the request was cancelled (-32800), as ACP has a
 *   client answer after `session/cancel`; and when `session/cancel` arrives while the agent still
 *   waits, the question is cancelled (`$/cancel_request`).
 * - `hang`: waits until the client cancels the prompt request itself.
 * - `fail`: fails with a JSON-RPC error of its own.
 * - `die`: dies.
 * - anything else: ends the turn.
 *
 * Every turn first sends one `session/update`.
 */

import { Deferred, Effect, Option, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { JsonRpcError, makePeer, type Wire } from "./peer.ts";

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
export const AgentRpcs = RpcGroup.make(
  Rpc.make("initialize", {
    payload: { protocolVersion: Schema.Finite },
    success: Schema.Struct({
      protocolVersion: Schema.Finite,
      agentCapabilities: Schema.Struct({ loadSession: Schema.Boolean }),
      authMethods: Schema.Array(Schema.Unknown),
    }),
    error: JsonRpcError,
  }),
  Rpc.make("session/new", {
    payload: { cwd: Schema.String },
    success: Schema.Struct({ sessionId: SessionId }),
    error: JsonRpcError,
  }),
  Rpc.make("session/prompt", {
    payload: {
      sessionId: SessionId,
      prompt: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
    },
    success: Schema.Struct({ stopReason: StopReason }),
    error: JsonRpcError,
  }),
  Rpc.make("session/cancel", { payload: { sessionId: SessionId } }),
);

/** What the agent asks of the client. */
export const ClientRpcs = RpcGroup.make(
  Rpc.make("session/request_permission", {
    payload: {
      sessionId: SessionId,
      toolCall: Schema.Struct({ toolCallId: Schema.String, title: Schema.String }),
      options: Schema.Array(PermissionOption),
    },
    success: Schema.Struct({ outcome: PermissionOutcome }),
    error: JsonRpcError,
  }),
);

/** What the agent tells the client. */
export const ClientNotifications = RpcGroup.make(
  Rpc.make("session/update", { payload: { sessionId: SessionId, update: Schema.Unknown } }),
);

/** What a test can watch of the agent from outside. */
export interface Probe {
  /** Completed when a `hang` turn's handler is interrupted. */
  readonly hangInterrupted: Deferred.Deferred<void>;
}

const text = (sessionId: string, words: string) => ({
  sessionId,
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: words } },
});

/** Runs the agent on `wire` until the scope closes. */
export const runAgent = (wire: Wire, probe: Probe) => {
  const cancels = new Map<string, Deferred.Deferred<void>>();
  let sessions = 0;
  return makePeer({
    wire,
    serve: AgentRpcs,
    call: ClientRpcs,
    notify: ClientNotifications,
    handlers: (peer) =>
      AgentRpcs.toLayer({
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
                  peer.client["session/request_permission"]({
                    sessionId,
                    toolCall: { toolCallId: "call-1", title: "write_file" },
                    options: [
                      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
                      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
                    ],
                  }).pipe(
                    Effect.map(({ outcome }) => (outcome.outcome === "cancelled" ? Option.none() : Option.some(outcome))),
                    Effect.catchIf(
                      (error) => "code" in error && error.code === -32800,
                      () => Effect.succeed(Option.none()),
                    ),
                  ),
                  Deferred.await(cancelled).pipe(Effect.as(Option.none())),
                );
                if (Option.isNone(answer)) return { stopReason: "cancelled" as const };
                yield* peer.notify("session/update", text(sessionId, `Answered: ${JSON.stringify(answer.value)}`));
                return { stopReason: "end_turn" as const };
              }
              case "hang":
                return yield* Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(probe.hangInterrupted, undefined)));
              case "fail":
                return yield* Effect.fail({ code: -32042, message: "Refused by the spike", data: { asked: "fail" } });
              case "die":
                return yield* Effect.die(new Error("the spike's handler died"));
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
