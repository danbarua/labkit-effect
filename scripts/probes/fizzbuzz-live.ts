/**
 * Live probe: the FizzBuzz scenario against a real model. The counting user sends 1, 3, 5, … up to
 * `count` messages; the model should classify each multiple of 3 or 5 with the `classify` tool and
 * reply with the number plus one. Writes the session's facts to `logs/live/` as a transcript
 * (`.md`) and as recorded (`.facts.jsonl`), and prints each turn the model got wrong and how many
 * it got right.
 *
 *   OPENAI_API_KEY=...    bun scripts/probes/fizzbuzz-live.ts openai gpt-5.5 45
 *   ANTHROPIC_API_KEY=... bun scripts/probes/fizzbuzz-live.ts anthropic claude-sonnet-5-5 45
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AnthropicClient } from "@effect/ai-anthropic";
import { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer, Redacted, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Fact } from "../../src/agent-machine/fact.ts";
import { ModelName, ProviderName, TestName } from "../../src/agent-machine/names.ts";
import { reportedBy } from "../../src/agent-session/origin.ts";
import { AnthropicModelClient } from "../../src/agent-session/providers/anthropic-client.ts";
import { OpenAiModelClient } from "../../src/agent-session/providers/openai-client.ts";
import { parseJson } from "../../src/agent-session/received.ts";
import { isObject } from "../../src/agent-session/shaping.ts";
import { basic, countingUser, play } from "../../src/examples/fizzbuzz/scenario.ts";
import { transcript } from "./transcript.ts";

const [provider = "openai", model = "gpt-5.5", counted = "45"] = process.argv.slice(2);
const count = Number(counted);
const variable = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
const key = process.env[variable];
if (key === undefined || key === "") {
  console.error(`${variable} is not set`);
  process.exit(2);
}
const apiKey = Redacted.make(key);

const client =
  provider === "anthropic"
    ? AnthropicModelClient.pipe(Layer.provide(AnthropicClient.layer({ apiKey }).pipe(Layer.provide(FetchHttpClient.layer))))
    : OpenAiModelClient.pipe(Layer.provide(OpenAiClient.layer({ apiKey }).pipe(Layer.provide(FetchHttpClient.layer))));

const { facts } = await Effect.runPromise(
  play(countingUser(count), {
    ...basic,
    model: { target: { provider: ProviderName.make(provider), model: ModelName.make(model) }, client },
  }).pipe(reportedBy({ _tag: "Test", name: TestName.make(`fizzbuzz-live ${provider} ${model}`) })),
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

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const name = [stamp, "fizzbuzz", provider, model, counted].join("-");
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

for (const line of wrong) console.log(line);
console.log(`${turns.size - wrong.length} of ${turns.size} turns right`);
console.log(`logs/live/${name}.md`);
