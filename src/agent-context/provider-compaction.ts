/**
 * A summarizer that asks the provider for its own compaction. The request carries the session's
 * system prompt and tools, the provider's earlier summaries (`summaryMessage`), and then the span's
 * messages, as a request would carry them. The items that the provider returns (such as a
 * `compaction` item) are the summary, as JSON. The Responses adapter's `openAiCompactions` does this
 * for OpenAI and xAI.
 *
 * The request is not recorded in the session's facts. A compaction that still fails after its
 * retries is a defect, because the session has no summary to continue with.
 */

import { Effect } from "effect";
import type * as AiError from "effect/ai/AiError";
import type { ModelContext, Target } from "../agent-session/contracts.ts";
import type { Compacted } from "../agent-session/providers/openai-compaction.ts";
import { type Summarizer, summaryMessage } from "./compaction.ts";
import { SummarizerName } from "./forks.ts";

export const providerCompaction = (
  compactions: (target: Target, context: ModelContext) => Effect.Effect<Compacted, AiError.AiError>,
): Summarizer => ({
  name: SummarizerName.make("ProviderCompaction"),
  summarize: (previous, messages, target, opening) =>
    compactions(target, {
      system: opening.system,
      tools: opening.tools,
      messages: previous.length === 0 ? messages : [summaryMessage(previous), ...messages],
    }).pipe(
      Effect.map((compacted) => compacted.output),
      Effect.orDie,
    ),
});
