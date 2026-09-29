/**
 * The loop's context assembler: the system prompt and tools the session's facts record, the
 * conversation as the `Conversation` service views the facts, and the notices as one instruction
 * message at its end, after the latest input or tool result.
 *
 * Notices are assembled for each request and are not facts, so what a request carried in them is
 * not recorded. The loop's `ModelProvider` chooses the model, so model selectors are not used here.
 */

import { Effect, Layer } from "effect";
import { ContextAssembler, type ContextMessage, type ModelContext } from "../agent-effect/contracts.ts";
import { conversationOf } from "../agent-effect/conversation.ts";
import { assembleContents, Conversation, Notices } from "./assemble.ts";

export const AgentContextAssembler = Layer.effect(
  ContextAssembler,
  Effect.gen(function* () {
    const services = yield* Effect.context<Conversation | Notices>();
    return {
      assemble: (facts) =>
        assembleContents(facts).pipe(
          Effect.provideContext(services),
          Effect.map((contents): ModelContext => {
            const notices: ReadonlyArray<ContextMessage> =
              contents.notices.length === 0
                ? []
                : [{ role: "instruction", parts: contents.notices.map((text) => ({ _tag: "Text", text })) }];
            return {
              system: contents.system.length === 0 ? undefined : contents.system.join("\n\n"),
              tools: contents.tools,
              messages: [...contents.messages, ...notices],
            };
          }),
        ),
    };
  }),
);

/** The whole session's conversation, every turn of it. */
export const WholeConversation = Layer.succeed(Conversation, {
  messages: (facts) => Effect.succeed(conversationOf(facts)),
});
