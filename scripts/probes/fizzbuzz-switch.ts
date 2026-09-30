/**
 * Live probe: one FizzBuzz session that switches between Claude and GPT. It starts on Claude Sonnet
 * 5.5; at a count of 8 it is compacted for Claude (plain text summary) and switched to GPT-5.5; at
 * 16 it is compacted for GPT (emoji summary) and switched back; it goes on to 20. Each provider is
 * sent its own summaries only (`CompactedConversation`), which are kept as files beside the
 * transcript. Prints how many replies were the number plus one, and the transcript's path.
 *
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... bun scripts/probes/fizzbuzz-switch.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AnthropicClient } from "@effect/ai-anthropic";
import { OpenAiClient } from "@effect/ai-openai";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, Layer, Redacted, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { CompactedConversation } from "../../src/agent-context/compaction.ts";
import { SummariesInFolder } from "../../src/agent-context/summaries-in-folder.ts";
import { Fact } from "../../src/agent-machine/fact.ts";
import { ModelName, ProviderName, TestName } from "../../src/agent-machine/names.ts";
import { FallbackModelClient } from "../../src/agent-session/model-fallback.ts";
import { reportedBy } from "../../src/agent-session/origin.ts";
import { anthropicRequests } from "../../src/agent-session/providers/anthropic-client.ts";
import { openAiRequests } from "../../src/agent-session/providers/openai-client.ts";
import { whenCountReaches } from "../../src/examples/fizzbuzz/compaction-policies.ts";
import { basic, countingUser, play } from "../../src/examples/fizzbuzz/scenario.ts";
import { EmojiHappyFizzBuzzSummarizer, PlainTextFizzBuzzSummarizer } from "../../src/examples/fizzbuzz/summarizers.ts";
import { transcript } from "./transcript.ts";

const keyOf = (variable: string) => {
  const key = process.env[variable];
  if (key === undefined || key === "") {
    console.error(`${variable} is not set`);
    process.exit(2);
  }
  return Redacted.make(key);
};

const claude = { provider: ProviderName.make("anthropic"), model: ModelName.make("claude-sonnet-5-5") };
const gpt = { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5") };

// One client that reaches both providers: a fallback chain with no fallbacks sends each request to
// the provider the session is asking.
const client = Layer.unwrap(
  Effect.gen(function* () {
    const anthropic = yield* anthropicRequests();
    const openai = yield* openAiRequests();
    return FallbackModelClient({ requests: new Map([[claude.provider, anthropic], [gpt.provider, openai]]), fallbacks: [] });
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(AnthropicClient.layer({ apiKey: keyOf("ANTHROPIC_API_KEY") }), OpenAiClient.layer({ apiKey: keyOf("OPENAI_API_KEY") })).pipe(
      Layer.provide(FetchHttpClient.layer),
    ),
  ),
);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const name = `${stamp}-fizzbuzz-switch`;
const folder = join("logs/live", `${name}.summaries`);

const { facts } = await Effect.runPromise(
  play(countingUser(10), {
    ...basic,
    model: { target: claude, client },
    conversation: CompactedConversation,
    compaction: whenCountReaches(
      new Map([
        [8, PlainTextFizzBuzzSummarizer],
        [16, EmojiHappyFizzBuzzSummarizer],
      ]),
    ),
    switches: new Map([
      [8, gpt],
      [16, claude],
    ]),
    summaries: SummariesInFolder(folder).pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
  }).pipe(reportedBy({ _tag: "Test", name: TestName.make("fizzbuzz-switch") })),
);

const replies = facts.flatMap((fact) => {
  if (fact._tag !== "Observed" || fact.observation._tag !== "ModelResponded") return [];
  const { provider, parts } = fact.observation;
  return parts.flatMap((part) => (part._tag === "Text" ? [[provider, part.text.trim()] as const] : []));
});
const expected = countingUser(10).map((n) => String(Number(n) + 1));

mkdirSync("logs/live", { recursive: true });
writeFileSync(
  join("logs/live", `${name}.md`),
  transcript(
    "fizzbuzz-switch",
    `One FizzBuzz session switching from Claude Sonnet 5.5 to GPT-5.5 at 8 and back at 16, compacting for the provider being left each time, run by \`bun scripts/probes/fizzbuzz-switch.ts\`. It is a probe, not one of the tests. The facts are in \`${name}.facts.jsonl\` and the summaries in \`${name}.summaries/\`.`,
    facts,
  ),
);
const encodeFact = Schema.encodeSync(Fact);
writeFileSync(join("logs/live", `${name}.facts.jsonl`), `${facts.map((fact) => JSON.stringify(encodeFact(fact))).join("\n")}\n`);

for (const [index, [provider, reply]] of replies.entries())
  if (reply !== expected[index]) console.log(`reply ${index + 1} from ${provider}: ${JSON.stringify(reply)} (expected ${expected[index]})`);
console.log(`${replies.filter(([, reply], index) => reply === expected[index]).length} of ${expected.length} replies right`);
console.log(`logs/live/${name}.md`);
