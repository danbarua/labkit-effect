/**
 * An ACP agent built with `agent.ts`, speaking versions 1 and 2, for the negotiation tests and the
 * stdio entry beside it. Its prompt handlers do what the prompt's text says:
 *
 * - `permission`: asks the client `session/request_permission`, then reports the answer.
 * - `read`: asks the client `fs/read_text_file`, then reports the content or the refusal.
 * - `elicit`: asks the client `elicitation/create` in form mode, then reports the answer or the refusal.
 * - `notice`: sends a `session/update` of kind `notice`, then reports whether it was sent or refused.
 *
 * Each turn first sends the update `Working.`; each report is one more `agent_message_chunk`.
 */

import { Effect, Schema } from "effect";
import * as Agent from "./agent.ts";
import type { JsonRpcError } from "./json-rpc.ts";
import * as Protocol from "./protocol.ts";
import * as V1 from "./schema/v1.gen.ts";
import * as V2 from "./schema/v2.gen.ts";

export const info = { name: "an-test-agent", version: "1.0.0" };

/** `json` decoded by `schema`, as a handler builds a value with branded ids from plain JSON. */
export const decode = <S extends Schema.Top>(schema: S, json: unknown): S["Type"] =>
  Schema.decodeUnknownSync(Schema.toCodecJson(schema) as unknown as Schema.Codec<S["Type"], unknown>)(json);

/** The text of an `agent_message_chunk` update, in either version. */
export function textOf(update: unknown): string | undefined {
  if (typeof update !== "object" || update === null || !("content" in update)) return undefined;
  const content = update.content;
  return typeof content === "object" && content !== null && "text" in content && typeof content.text === "string"
    ? content.text
    : undefined;
}

/** What a failed call to the client is reported as. */
const reported = (error: { readonly _tag?: string; readonly capability?: string; readonly code?: number }): string =>
  error._tag === "CapabilityNotAdvertised" ? `Refused: ${error.capability}` : `Failed: ${error.code ?? error._tag}`;

const internal = (error: unknown): JsonRpcError => ({ code: -32603, message: "Internal error", data: String(error) });

export const v1 = (capabilities: V1.AgentCapabilities = {}) =>
  Agent.implement(Protocol.v1, {
    capabilities,
    handlers: (connection) =>
      Effect.sync(() => {
        let sessions = 0;
        const say = (sessionId: string, text: string) =>
          connection.notify(
            "session/update",
            decode(V1.SessionNotification, { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }),
          );
        return {
          "session/new": () => Effect.succeed({ sessionId: V1.SessionId.make(`session-${++sessions}`) }),
          "session/load": () => Effect.succeed({}),
          "session/cancel": () => Effect.void,
          "session/prompt": ({ sessionId, prompt }) =>
            Effect.gen(function* () {
              yield* say(sessionId, "Working.");
              const first = prompt[0];
              switch (first?.type === "text" ? first.text : "") {
                case "permission": {
                  const answer = yield* connection.client["session/request_permission"](
                    decode(V1.RequestPermissionRequest, {
                      sessionId,
                      toolCall: { toolCallId: "call-1", title: "Write a file" },
                      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
                    }),
                  );
                  yield* say(sessionId, `Answered: ${JSON.stringify(answer.outcome)}`);
                  break;
                }
                case "read": {
                  const read = yield* connection.client["fs/read_text_file"]({ sessionId, path: "/tmp/an-test.txt" }).pipe(Effect.result);
                  yield* say(sessionId, read._tag === "Success" ? `Read: ${read.success.content}` : reported(read.failure));
                  break;
                }
                case "elicit": {
                  const elicited = yield* connection.client["elicitation/create"](
                    decode(V1.CreateElicitationRequest, {
                      sessionId,
                      mode: "form",
                      message: "Your name?",
                      requestedSchema: { type: "object", properties: {} },
                    }),
                  ).pipe(Effect.result);
                  yield* say(sessionId, elicited._tag === "Success" ? `Elicited: ${JSON.stringify(elicited.success)}` : reported(elicited.failure));
                  break;
                }
                case "notice": {
                  const sent = yield* connection
                    .notify(
                      "session/update",
                      decode(V1.SessionNotification, { sessionId, update: { sessionUpdate: "notice", severity: "info", title: "Heads up" } }),
                    )
                    .pipe(Effect.result);
                  yield* say(sessionId, sent._tag === "Success" ? "Noticed." : reported(sent.failure));
                  break;
                }
              }
              return { stopReason: "end_turn" as const };
            }).pipe(Effect.mapError(internal)),
        };
      }),
  });

export const v2 = (capabilities: V2.AgentCapabilities = { session: {} }) =>
  Agent.implement(Protocol.v2, {
    capabilities,
    handlers: (connection) =>
      Effect.sync(() => {
        let sessions = 0;
        let messages = 0;
        return {
          "session/new": () => Effect.succeed({ sessionId: V2.SessionId.make(`session-${++sessions}`) }),
          "session/cancel": () => Effect.void,
          "session/prompt": ({ sessionId, prompt }) =>
            Effect.gen(function* () {
              const messageId = `message-${++messages}`;
              const say = (text: string) =>
                connection.notify(
                  "session/update",
                  decode(V2.UpdateSessionNotification, {
                    sessionId,
                    update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } },
                  }),
                );
              yield* say("Working.");
              const first = prompt[0];
              if (first?.type === "text" && first.text === "permission") {
                const answer = yield* connection.client["session/request_permission"](
                  decode(V2.RequestPermissionRequest, {
                    sessionId,
                    title: "Write a file",
                    options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
                  }),
                );
                yield* say(`Answered: ${JSON.stringify(answer.outcome)}`);
              }
              return { messageId: V2.MessageId.make(messageId) };
            }).pipe(Effect.mapError(internal)),
        };
      }),
  });
