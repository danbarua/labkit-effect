/**
 * Grok's own compaction: the Responses adapter's compaction (`openai-compaction.ts`), through the
 * configured `OpenAiClient`, which `xAiClient` points at xAI. Grok returns one `compaction` item.
 */

import { type Retries, defaultRetries } from "../provider-call.ts";
import { openAiCompactions } from "./openai-compaction.ts";

export const xAiCompactions = (retries: Retries = defaultRetries) => openAiCompactions(retries);
