/**
 * The loop's context assembler. A request carries the system prompt and tools that the session's
 * facts record, the conversation as the `Conversation` service gives it, and the notices as one
 * instruction message at the end, after the latest input or tool result.
 *
 * Each notice is recorded as `NoticeInserted` for the request's turn, so later requests carry it at
 * the same place. A provider that checks the prefix before a thinking block rejects a request that
 * omits a notice sent earlier. The loop's `ModelProvider` chooses the model, so model selectors are
 * not used here.
 */

import { Effect, Layer } from "effect";
import { NoticeText } from "../agent-machine/names.ts";
import { ContextAssembler, type ModelContext } from "../agent-session/contracts.ts";
import { nextMessages, noticeMessage } from "../agent-session/conversation.ts";
import { harnessParts } from "../agent-session/origin.ts";
import { Report } from "../agent-session/report.ts";
import { assembleContents, Conversation } from "./assemble.ts";

export const AgentContextAssembler = Layer.effect(
  ContextAssembler,
  Effect.gen(function* () {
    // The notice providers (`Notices`) are read from the context that the layer is built in.
    const services = yield* Effect.context<Conversation>();
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

/**
 * The whole session's conversation (`nextMessages`): the messages that the last request carried, as
 * recorded, followed by the messages of the facts since.
 */
export const WholeConversation = Layer.succeed(Conversation, {
  messages: (facts) => Effect.succeed(nextMessages(facts)),
});
