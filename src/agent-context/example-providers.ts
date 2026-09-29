/**
 * Providers and selectors for trying context assembly: the current time as a notice, a fixed
 * model, and a move to a larger model when the context is estimated not to fit.
 */

import { DateTime, Effect } from "effect";
import type { ContextMessage } from "../agent-effect/contracts.ts";
import type { Contents, ModelChoice, ModelSelector, NoticeProvider } from "./assemble.ts";
import { logKeys } from "./log-keys.ts";

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
      case "Thinking":
        return total + part.text.length + part.signature.length;
      case "Unrecognised":
        return total + JSON.stringify(part.received).length;
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
