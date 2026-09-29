/**
 * The loop's context assembler, built from context assembly's services: the system prompts joined
 * into one, the tool catalogs, and the conversation as the `Conversation` service views the facts.
 *
 * The loop's `ModelProvider` chooses the model, so model selectors are not used here. Notices are
 * not sent: `ModelContext` has no place for them yet. Any that are assembled are logged as not sent.
 */

import { Effect, Layer } from "effect";
import { ContextAssembler, type ModelContext } from "../agent-effect/contracts.ts";
import { conversationOf } from "../agent-effect/conversation.ts";
import { assembleContents, Conversation, Notices, SystemPrompts, ToolCatalogs } from "./assemble.ts";
import { logKeys } from "./log-keys.ts";

export const AgentContextAssembler = Layer.effect(
  ContextAssembler,
  Effect.gen(function* () {
    const services = yield* Effect.context<Conversation | SystemPrompts | ToolCatalogs | Notices>();
    return {
      assemble: (facts) =>
        assembleContents(facts).pipe(
          Effect.provideContext(services),
          Effect.tap((contents) =>
            contents.notices.length === 0
              ? Effect.void
              : Effect.logWarning(logKeys.assembly.noticesNotSent, {
                  notices: contents.notices,
                  reason: "the model context has no place for notices",
                }),
          ),
          Effect.map(
            (contents): ModelContext => ({
              system: contents.system.length === 0 ? undefined : contents.system.join("\n\n"),
              tools: contents.tools,
              messages: contents.messages,
            }),
          ),
        ),
    };
  }),
);

/** The whole session's conversation, every turn of it. */
export const WholeConversation = Layer.succeed(Conversation, {
  messages: (facts) => Effect.succeed(conversationOf(facts)),
});
