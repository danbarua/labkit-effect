/**
 * The loop's context assembler: the system prompt and tools the session's facts record, the
 * conversation as the `Conversation` service views the facts, and the notices as one instruction
 * message at its end, after the latest input or tool result.
 *
 * Each notice is reported as `NoticeInserted` for the request's turn, so later requests carry it in
 * the same place: a provider that checks the prefix before a thinking block rejects a request that
 * leaves out a notice sent before it. The loop's `ModelProvider` chooses the model, so model
 * selectors are not used here.
 */

import { Effect, Layer } from "effect";
import { NoticeText } from "../agent-core/names.ts";
import { ContextAssembler, type ModelContext } from "../agent-effect/contracts.ts";
import { conversationOf, noticeMessage } from "../agent-effect/conversation.ts";
import { harnessParts } from "../agent-effect/origin.ts";
import { Report } from "../agent-effect/report.ts";
import { assembleContents, Conversation, Notices } from "./assemble.ts";

export const AgentContextAssembler = Layer.effect(
  ContextAssembler,
  Effect.gen(function* () {
    const services = yield* Effect.context<Conversation | Notices>();
    return {
      assemble: (facts, turn) =>
        Effect.gen(function* () {
          const contents = yield* assembleContents(facts).pipe(Effect.provideContext(services));
          const notices = contents.notices.map((text) => NoticeText.make(text));
          const report = yield* Report;
          yield* Effect.forEach(
            notices,
            (text) => report({ _tag: "NoticeInserted", turn, text }, harnessParts.contextAssembler),
            { discard: true },
          );
          const context: ModelContext = {
            system: contents.system.length === 0 ? undefined : contents.system.join("\n\n"),
            tools: contents.tools,
            messages: notices.length === 0 ? contents.messages : [...contents.messages, noticeMessage(notices)],
          };
          return context;
        }),
    };
  }),
);

/** The whole session's conversation, every turn of it. */
export const WholeConversation = Layer.succeed(Conversation, {
  messages: (facts) => Effect.succeed(conversationOf(facts)),
});
