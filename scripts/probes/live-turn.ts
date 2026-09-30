/**
 * Live probe: one tool-calling turn through the loop and a real provider's adapter, so a change to
 * what an adapter sends back can be checked against the provider itself. Writes the session's facts
 * to `logs/live/` as a transcript to read (`.md`) and as recorded (`.facts.jsonl`), and prints how
 * the turn ended and the transcript's path.
 *
 *   OPENAI_API_KEY=...    bun scripts/probes/live-turn.ts openai gpt-5.5
 *   ANTHROPIC_API_KEY=... bun scripts/probes/live-turn.ts anthropic claude-opus-5-5
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AnthropicClient } from "@effect/ai-anthropic";
import { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer, Redacted, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Fact } from "../../src/agent-core/fact.ts";
import { ModelName, ProviderName, SessionId, TestName } from "../../src/agent-core/names.ts";
import type { Observation } from "../../src/agent-core/observation.ts";
import { openSession } from "../../src/agent-effect/loop.ts";
import { ModelFromFacts } from "../../src/agent-effect/model-choice.ts";
import { reportedBy } from "../../src/agent-effect/origin.ts";
import { AnthropicModelClient } from "../../src/agent-effect/providers/anthropic-client.ts";
import { OpenAiModelClient } from "../../src/agent-effect/providers/openai-client.ts";
import { openedWith } from "../../src/agent-effect/session-setup.ts";
import { TurnContextAssembler } from "../../src/agent-effect/turn-context.ts";
import { CountingTurns, NoTurnEndHooks } from "../../src/agent-effect/turns.ts";
import { SmolToolRunner, smolCatalog } from "../../tests/support/smol-tools.ts";
import { transcript } from "./transcript.ts";

const [provider = "openai", model = "gpt-5.5"] = process.argv.slice(2);
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

const encodeFact = Schema.encodeSync(Fact);

const facts = await Effect.runPromise(
  Effect.gen(function* () {
    const session = yield* openSession;
    yield* session.observe(
      openedWith({
        session: SessionId.make("live"),
        model: { provider: ProviderName.make(provider), model: ModelName.make(model) },
        system: "Before each tool call, say in one sentence what you are about to do.",
        tools: smolCatalog,
      }),
    );
    yield* session.observe({
      _tag: "InputArrived",
      from: { _tag: "User" },
      text: "Add 1873 and 7519 with the tool, then tell me the result.",
    } as unknown as Observation);
    return yield* session.facts;
  }).pipe(
    reportedBy({ _tag: "Test", name: TestName.make(`live-turn ${provider} ${model}`) }),
    Effect.provide(Layer.mergeAll(ModelFromFacts, TurnContextAssembler, client, CountingTurns, NoTurnEndHooks, SmolToolRunner)),
  ),
);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const name = `${stamp}-${provider}-${model}`;
mkdirSync("logs/live", { recursive: true });
writeFileSync(join("logs/live", `${name}.md`), transcript(`live-turn ${provider} ${model}`, facts));
writeFileSync(join("logs/live", `${name}.facts.jsonl`), `${facts.map((fact) => JSON.stringify(encodeFact(fact))).join("\n")}\n`);

const ended = facts.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" ? [fact.decision.ending._tag] : []));
console.log(`turn ended: ${ended.join(", ") || "not ended"}`);
console.log(`logs/live/${name}.md`);
