/**
 * One provider of each kind, for trying context assembly.
 */

import { DateTime, Effect } from "effect";
import { ToolName } from "../agent-core/names.ts";
import type { ContextMessage } from "../agent-effect/contracts.ts";
import type {
  Contents,
  ModelChoice,
  ModelSelector,
  NoticeProvider,
  SystemPromptProvider,
  ToolCatalog,
} from "./assemble.ts";
import { logKeys } from "./log-keys.ts";

export const BoringSystemPromptProvider: SystemPromptProvider = {
  system: Effect.succeed(["You are a helpful assistant."]),
};

/** One tool, `echo`, which answers "PONG". */
export const BoringToolCatalog: ToolCatalog = {
  tools: Effect.succeed([
    {
      name: ToolName.make("echo"),
      description: 'Answers "PONG".',
      input: { type: "object", properties: {} },
    },
  ]),
};

/** A notice of the current time, from the clock the program runs with. */
export const SystemTimeNoticeProvider: NoticeProvider = {
  notices: DateTime.now.pipe(Effect.map((now) => [`The current time is ${DateTime.formatIso(now)}.`])),
};

/** Always the same model. */
export const FixedModelSelector = (model: ModelChoice): ModelSelector => ({
  select: () => Effect.succeed(model),
});

function characters(message: ContextMessage): number {
  return message.parts.reduce((total, part) => {
    switch (part._tag) {
      case "Text":
        return total + part.text.length;
      case "ToolCall":
        return total + part.tool.length + JSON.stringify(part.input).length;
      case "ToolResult":
        return total + JSON.stringify(part.outcome).length;
      default:
        return part satisfies never;
    }
  }, 0);
}

/**
 * An estimate of the tokens in the contents: four characters to a token. It is an estimate, not a
 * count; a provider's tokenizer counts differently.
 */
export function estimatedTokens(contents: Contents): number {
  const text =
    contents.system.join("").length +
    contents.notices.join("").length +
    JSON.stringify(contents.tools).length +
    contents.messages.reduce((total, message) => total + characters(message), 0);
  return Math.ceil(text / 4);
}

/**
 * Moves to `larger` when the contents are estimated not to fit the model chosen so far; otherwise
 * keeps it. The move is logged with the estimate.
 */
export const ContextWindowAwareModelSelector = (larger: ModelChoice): ModelSelector => ({
  select: (contents, chosen) => {
    const estimate = estimatedTokens(contents);
    if (chosen !== undefined && estimate <= chosen.contextWindow) return Effect.succeed(chosen);
    return Effect.logInfo(logKeys.selection.modelUpgraded, {
      from: chosen?.model,
      fromWindow: chosen?.contextWindow,
      to: larger.model,
      toWindow: larger.contextWindow,
      estimatedTokens: estimate,
      reason: "the assembled context is estimated not to fit the model chosen so far",
    }).pipe(Effect.as(larger));
  },
});
