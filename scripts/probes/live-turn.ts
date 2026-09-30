/**
 * Live probe: one tool-calling turn through the loop and a real provider's adapter. Prints each
 * response's parts and how the turn ended, so a change to what an adapter sends back can be checked
 * against the provider itself.
 *
 *   OPENAI_API_KEY=...    bun scripts/probes/live-turn.ts openai gpt-5.5
 *   ANTHROPIC_API_KEY=... bun scripts/probes/live-turn.ts anthropic claude-opus-5-5
 */

import { AnthropicClient } from "@effect/ai-anthropic";
import { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer, Redacted } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ModelName, ProviderName, SessionId } from "../../src/agent-core/names.ts";
import type { Observation } from "../../src/agent-core/observation.ts";
import { openSession } from "../../src/agent-effect/loop.ts";
import { ModelFromFacts } from "../../src/agent-effect/model-choice.ts";
import { AnthropicModelClient } from "../../src/agent-effect/providers/anthropic-client.ts";
import { OpenAiModelClient } from "../../src/agent-effect/providers/openai-client.ts";
import { asText } from "../../src/agent-effect/received.ts";
import { openedWith } from "../../src/agent-effect/session-setup.ts";
import { TurnContextAssembler } from "../../src/agent-effect/turn-context.ts";
import { CountingTurns, NoTurnEndHooks } from "../../src/agent-effect/turns.ts";
import { SmolToolRunner, smolCatalog } from "../../tests/support/smol-tools.ts";

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
  }).pipe(Effect.provide(Layer.mergeAll(ModelFromFacts, TurnContextAssembler, client, CountingTurns, NoTurnEndHooks, SmolToolRunner))),
);

for (const fact of facts) {
  if (fact._tag === "Decided" && fact.decision._tag === "TurnEnded") console.log("turn ended:", JSON.stringify(fact.decision.ending));
  if (fact._tag !== "Observed") continue;
  const observation = fact.observation;
  if (observation._tag === "ModelFailed") console.log("failed:", observation.failure, asText(observation.error).slice(0, 600));
  if (observation._tag === "ModelResponded")
    console.log(
      "responded:",
      observation.stop,
      JSON.stringify(
        observation.parts.map((part) =>
          part._tag === "Text" || part._tag === "Commentary" || part._tag === "Thinking"
            ? [part._tag, part.text.slice(0, 70)]
            : part._tag === "ToolCall"
              ? [part._tag, part.tool]
              : [part._tag, asText(part.received).slice(0, 70)],
        ),
      ),
    );
}
