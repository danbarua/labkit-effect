/**
 * Live probe: the FizzBuzz scenario against a real model. The counting user sends 1, 3, 5, … up to
 * `count` messages; the model should classify each multiple of 3 or 5 with the `classify` tool and
 * reply with the number plus one. Writes the session's facts to `logs/live/` as a transcript
 * (`.md`) and as recorded (`.facts.jsonl`), with its spans (`.spans.jsonl`) and log lines
 * (`.logs.jsonl`) beside them, and prints each turn the model got wrong, how many it got right, and
 * the paths of the transcript and the spans.
 *
 * With `compact`, the session is compacted when the count reaches 30, 60 and 90; with `fizzbuzz`,
 * after every turn in which the model classified FizzBuzz. The compactions are written by the
 * plain text summarizer, the emoji one, and the plain text one after that, and the model is sent
 * the summaries in place of the turns they cover (`CompactedConversation`). With `provider` (openai
 * or xai), the session is compacted after every FizzBuzz by the provider's own compaction
 * (`providerCompaction`), and the model is sent the items it returned.
 *
 *   OPENAI_API_KEY=...    bun scripts/probes/fizzbuzz-live.ts openai gpt-5.5 45
 *   ANTHROPIC_API_KEY=... bun scripts/probes/fizzbuzz-live.ts anthropic claude-sonnet-5-5 47 compact
 *   ANTHROPIC_API_KEY=... bun scripts/probes/fizzbuzz-live.ts anthropic claude-sonnet-5-5 39 fizzbuzz
 *   XAI_API_KEY=...       bun scripts/probes/fizzbuzz-live.ts xai grok-4.7 20
 *   XAI_API_KEY=...       bun scripts/probes/fizzbuzz-live.ts xai grok-4.7 50 provider
 *
 * Settings follow as `name=value`, as for `live-turn.ts` (`cache=5m`). The probe prints the input
 * tokens the responses report as read from the cache, written to it, and neither.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AnthropicClient } from "@effect/ai-anthropic";
import { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer, Redacted, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { CompactedConversation } from "../../src/agent-context/compaction.ts";
import { Fact } from "../../src/agent-machine/fact.ts";
import { contextGauge } from "../../src/agent-session/accounting.ts";
import { ModelSettings } from "../../src/agent-machine/settings.ts";
import { ModelName, ProviderName, TestName } from "../../src/agent-machine/names.ts";
import { reportedBy } from "../../src/agent-session/origin.ts";
import { AnthropicModelClient } from "../../src/agent-session/providers/anthropic-client.ts";
import { OpenAiModelClient } from "../../src/agent-session/providers/openai-client.ts";
import { openAiCompactions } from "../../src/agent-session/providers/openai-compaction.ts";
import { providerCompaction } from "../../src/agent-context/provider-compaction.ts";
import { XAiModelClient, xAiClient } from "../../src/agent-session/providers/xai-client.ts";
import { asText, parseJson } from "../../src/agent-session/received.ts";
import { isObject } from "../../src/agent-session/shaping.ts";
import { afterFizzBuzz, whenCountReaches } from "../../src/examples/fizzbuzz/compaction-policies.ts";
import { basic, countingUser, play } from "../../src/examples/fizzbuzz/scenario.ts";
import { EmojiHappyFizzBuzzSummarizer, PlainTextFizzBuzzSummarizer } from "../../src/examples/fizzbuzz/summarizers.ts";
import { TelemetryToFiles } from "../../src/instrumentation/telemetry.ts";
import { transcript } from "./transcript.ts";

const [provider = "openai", model = "gpt-5.5", counted = "45", ...rest] = process.argv.slice(2);
const compacting = rest.find((each) => !each.includes("="));
const said = rest.filter((each) => each.includes("="));
// A setting the core does not know fails here, as it would in a recorded opening.
const settings = Schema.decodeUnknownSync(ModelSettings)(
  Object.fromEntries(
    said.map((each) => {
      const [name, value = ""] = each.split("=");
      return [name, /^\d+$/.test(value) ? Number(value) : value];
    }),
  ),
  { onExcessProperty: "error" },
);
const summarizers = [PlainTextFizzBuzzSummarizer, EmojiHappyFizzBuzzSummarizer, PlainTextFizzBuzzSummarizer];
const count = Number(counted);
const variable = provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "xai" ? "XAI_API_KEY" : "OPENAI_API_KEY";
const key = process.env[variable];
if (key === undefined || key === "") {
  console.error(`${variable} is not set`);
  process.exit(2);
}
const apiKey = Redacted.make(key);

const openAiClientLayer = (provider === "xai" ? xAiClient(apiKey) : OpenAiClient.layer({ apiKey })).pipe(Layer.provide(FetchHttpClient.layer));
// The provider's own compaction, asked through the same client as the requests.
const byProvider =
  compacting === "provider" ? providerCompaction(await Effect.runPromise(openAiCompactions().pipe(Effect.provide(openAiClientLayer)))) : undefined;

const client =
  provider === "anthropic"
    ? AnthropicModelClient.pipe(Layer.provide(AnthropicClient.layer({ apiKey }).pipe(Layer.provide(FetchHttpClient.layer))))
    : provider === "xai"
      ? XAiModelClient.pipe(Layer.provide(xAiClient(apiKey).pipe(Layer.provide(FetchHttpClient.layer))))
      : OpenAiModelClient.pipe(Layer.provide(OpenAiClient.layer({ apiKey }).pipe(Layer.provide(FetchHttpClient.layer))));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const name = [stamp, "fizzbuzz", provider, model, counted, ...rest].join("-");

const { facts, summaries } = await Effect.runPromise(
  play(countingUser(count), {
    ...basic,
    ...(compacting === undefined
      ? {}
      : {
          conversation: CompactedConversation,
          compaction:
            byProvider !== undefined
              ? afterFizzBuzz(() => byProvider)
              : compacting === "fizzbuzz"
              ? afterFizzBuzz((compacted) => summarizers[compacted] ?? PlainTextFizzBuzzSummarizer)
              : whenCountReaches(new Map([30, 60, 90].map((count, index) => [count, summarizers[index] ?? PlainTextFizzBuzzSummarizer]))),
        }),
    model: { target: { provider: ProviderName.make(provider), model: ModelName.make(model), settings }, client },
  }).pipe(
    reportedBy({ _tag: "Test", name: TestName.make(`fizzbuzz-live ${provider} ${model}`) }),
    Effect.provide(TelemetryToFiles(join("logs/live", name))),
  ),
);

/** What each turn was given, what it classified it as, and what it replied, in order. */
const turns = new Map<string, { asked: string | undefined; labels: Array<string>; reply?: string }>();
const inputs = new Map(
  facts.flatMap((fact) =>
    fact._tag === "Observed" && fact.observation._tag === "InputArrived" ? [[fact.seq, fact.observation.text] as const] : [],
  ),
);
for (const fact of facts) {
  if (fact._tag === "Decided" && fact.decision._tag === "InputDelivered")
    turns.set(fact.decision.turn, { asked: inputs.get(fact.decision.inputs[0] ?? fact.seq), labels: [] });
  if (fact._tag === "Observed" && fact.observation._tag === "ModelResponded") {
    const turn = turns.get(fact.observation.turn);
    if (turn === undefined) continue;
    for (const part of fact.observation.parts) {
      if (part._tag === "ToolCall" && part.tool === "classify") {
        const input = parseJson(part.input);
        const label = "value" in input && isObject(input.value) ? input.value["label"] : undefined;
        turn.labels.push(typeof label === "string" ? label : JSON.stringify(label ?? null));
      }
      if (part._tag === "Text") turn.reply = part.text;
    }
  }
}

const expectedLabel = (n: number): string | undefined =>
  n % 15 === 0 ? "FizzBuzz" : n % 3 === 0 ? "Fizz" : n % 5 === 0 ? "Buzz" : undefined;
const wrong = [...turns.entries()].flatMap(([turn, { asked, labels, reply }]) => {
  const n = Number(asked);
  const label = expectedLabel(n);
  const labelsRight = label === undefined ? labels.length === 0 : labels.length === 1 && labels[0] === label;
  const replyRight = reply?.trim() === String(n + 1);
  return labelsRight && replyRight
    ? []
    : [`${turn}: asked ${asked}; classified ${labels.join(", ") || "nothing"} (expected ${label ?? "nothing"}); replied ${JSON.stringify(reply ?? null)} (expected ${n + 1})`];
});

mkdirSync("logs/live", { recursive: true });
writeFileSync(
  join("logs/live", `${name}.md`),
  transcript(
    `fizzbuzz-live ${provider} ${model} ${counted}`,
    `The FizzBuzz scenario, ${count} user messages, run through the loop against ${provider}'s API by \`bun scripts/probes/fizzbuzz-live.ts ${provider} ${model} ${counted}\`. It is a probe, not one of the tests. The facts as recorded are beside this file, in \`${name}.facts.jsonl\`.`,
    facts,
  ),
);
const encodeFact = Schema.encodeSync(Fact);
writeFileSync(join("logs/live", `${name}.facts.jsonl`), `${facts.map((fact) => JSON.stringify(encodeFact(fact))).join("\n")}\n`);

/** The input tokens each response reports, summed: read from the cache, written to it, and neither. */
const usage = { cacheRead: 0, cacheWritten: 0, uncached: 0 };
for (const fact of facts) {
  if (fact._tag !== "Observed" || fact.observation._tag !== "ModelResponded") continue;
  const metadata = parseJson(fact.observation.metadata);
  const reported = "value" in metadata && isObject(metadata.value) ? metadata.value["usage"] : undefined;
  if (reported === undefined || !isObject(reported)) continue;
  const count = (value: unknown) => (typeof value === "number" ? value : 0);
  const details = reported["input_tokens_details"] ?? null;
  if (provider === "anthropic") {
    usage.cacheRead += count(reported["cache_read_input_tokens"]);
    usage.cacheWritten += count(reported["cache_creation_input_tokens"]);
    usage.uncached += count(reported["input_tokens"]);
  } else {
    const read = isObject(details) ? count(details["cached_tokens"]) : 0;
    usage.cacheRead += read;
    usage.uncached += count(reported["input_tokens"]) - read;
  }
}

for (const summary of summaries) {
  const parsed = parseJson(summary.summary);
  const items = "value" in parsed && Array.isArray(parsed.value) ? parsed.value.map((item) => (isObject(item) ? item["type"] : null)) : undefined;
  console.log(`summary ${summary.window} by ${summary.writtenBy}: ${items === undefined ? `${asText(summary.summary).length} characters` : `items ${JSON.stringify(items)}`}`);
}
for (const line of wrong) console.log(line);
console.log(`input tokens: ${JSON.stringify(usage)}`);
console.log(`context gauge: ${JSON.stringify(contextGauge(facts, provider, model) ?? null)}`);
console.log(`${turns.size - wrong.length} of ${turns.size} turns right`);
console.log(`logs/live/${name}.md`);
console.log(`logs/live/${name}.spans.jsonl`);
