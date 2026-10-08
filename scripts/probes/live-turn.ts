/**
 * Live probe: one tool-calling turn through the loop and a real provider's adapter, so a change to
 * what an adapter sends back can be checked against the provider itself. Writes the session's facts
 * to the run's folder (`logs/probes/live-turn/<run>/`) as a transcript to read (`transcript.md`) and
 * as recorded (`facts.jsonl`), with its spans (`telemetry.spans.jsonl`) and log lines
 * (`telemetry.logs.jsonl`) beside them, and prints how the turn ended and the paths of the
 * transcript and the spans.
 *
 * Settings follow the model as `name=value` (`thinking`, `observe`, `effort`, `maxOutputTokens`).
 *
 *   OPENAI_API_KEY=...    bun scripts/probes/live-turn.ts openai gpt-5.5 observe=all
 *   ANTHROPIC_API_KEY=... bun scripts/probes/live-turn.ts anthropic claude-opus-5-5 observe=all effort=high
 *   XAI_API_KEY=...       bun scripts/probes/live-turn.ts xai grok-4.7 observe=all
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runFolder } from "./run-folder.ts";
import { AnthropicClient } from "@effect/ai-anthropic";
import { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer, Redacted, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { logLevelOf, withLogLevel } from "../../src/agent-host/log-level.ts";
import { Fact } from "../../src/agent-machine/fact.ts";
import { ModelName, ProviderName, SessionId, TestName } from "../../src/agent-machine/names.ts";
import type { Observation } from "../../src/agent-machine/observation.ts";
import { ModelSettings } from "../../src/agent-machine/settings.ts";
import { openSession } from "../../src/agent-session/loop.ts";
import { inSession, makeSessionContext } from "../../src/agent-host/session-context.ts";
import { EphemeralSessionStore } from "../../src/agent-session/session-store.ts";
import { ModelFromFacts } from "../../src/agent-session/configuration/model-choice.ts";
import { reportedBy } from "../../src/agent-session/origin.ts";
import { AnthropicModelClient } from "../../src/agent-session/providers/anthropic-client.ts";
import { OpenAiModelClient } from "../../src/agent-session/providers/openai-client.ts";
import { XAiModelClient, xAiClient } from "../../src/agent-session/providers/xai-client.ts";
import { openedWith } from "../../src/agent-session/configuration/session-setup.ts";
import { TurnContextAssembler } from "../../src/agent-session/turn-context.ts";
import { CountingTurns } from "../../src/agent-session/turns.ts";
import { SmolToolRunner, smolCatalog } from "../../tests/support/smol-tools.ts";
import { capturingHttp } from "../../src/instrumentation/http-captures.ts";
import { TelemetryToFiles } from "../../src/instrumentation/telemetry.ts";
import { transcript } from "./transcript.ts";

const [provider = "openai", model = "gpt-5.5", ...said] = process.argv.slice(2);
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
const variable = provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "xai" ? "XAI_API_KEY" : "OPENAI_API_KEY";
const key = process.env[variable];
if (key === undefined || key === "") {
  console.error(`${variable} is not set`);
  process.exit(2);
}
const apiKey = Redacted.make(key);

const client =
  provider === "anthropic"
    ? AnthropicModelClient.pipe(Layer.provide(AnthropicClient.layer({ apiKey }).pipe(Layer.provide(capturingHttp(FetchHttpClient.layer)))))
    : provider === "xai"
      ? XAiModelClient.pipe(Layer.provide(xAiClient(apiKey).pipe(Layer.provide(capturingHttp(FetchHttpClient.layer)))))
      : OpenAiModelClient.pipe(Layer.provide(OpenAiClient.layer({ apiKey }).pipe(Layer.provide(capturingHttp(FetchHttpClient.layer)))));

const encodeFact = Schema.encodeSync(Fact);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const name = [stamp, provider, model, ...said].join("-");
const run = runFolder("live-turn", name);

const facts = await Effect.runPromise(
  Effect.flatMap(makeSessionContext({ session: SessionId.make("live"), working: process.cwd(), given: [] }), (made) =>
    inSession(made.context)(
      Effect.gen(function* () {
        const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
        yield* made.storeOpened(session.facts);
        yield* session.observe(
          openedWith({
            session: SessionId.make("live"),
            model: { provider: ProviderName.make(provider), model: ModelName.make(model), settings },
            system: "Before each tool call, say in one sentence what you are about to do.",
            tools: smolCatalog,
          }),
        );
        yield* session.idle;
        yield* session.observe({
          _tag: "InputArrived",
          from: { _tag: "User" },
          // Hard enough that a model which thinks as it sees fit does think.
          text:
            "Of 1873, 4127, 2946, 6054, 3381 and 7519, exactly two are the smallest and largest primes in the list. " +
            "Work out which, add those two with the tool, then tell me the result.",
        } as unknown as Observation);
        yield* session.idle;
        return yield* session.facts;
      }),
    ),
  ).pipe(
    reportedBy({ _tag: "Test", name: TestName.make(`live-turn ${provider} ${model}`) }),
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        ModelFromFacts,
        TurnContextAssembler,
        client,
        CountingTurns,
        SmolToolRunner,
        withLogLevel(logLevelOf(process.env), TelemetryToFiles(join(run, "telemetry"))),
      ),
    ),
  ),
);

writeFileSync(
  join(run, "transcript.md"),
  transcript(
    ["live-turn", provider, model, ...said].join(" "),
    `One turn with a tool call, run through the loop against ${provider}'s API by \`bun scripts/probes/live-turn.ts ${[provider, model, ...said].join(" ")}\`. It is a probe, not one of the tests. The facts as recorded are beside this file, in \`${name}.facts.jsonl\`.`,
    facts,
  ),
);
writeFileSync(join(run, "facts.jsonl"), `${facts.map((fact) => JSON.stringify(encodeFact(fact))).join("\n")}\n`);

const ended = facts.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" ? [fact.decision.ending._tag] : []));
console.log(`turn ended: ${ended.join(", ") || "not ended"}`);
console.log(join(run, "transcript.md"));
console.log(join(run, "telemetry.spans.jsonl"));
