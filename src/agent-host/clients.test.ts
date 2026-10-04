/** The model client the hosts use: one provider client for each provider whose key is set, and the local server's. */

import { expect } from "bun:test";
import { Effect, Exit } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { ModelName, ProviderName, TurnId } from "../agent-machine/names.ts";
import { ModelClient } from "../agent-session/contracts.ts";
import { Report } from "../agent-session/report.ts";
import { Clients } from "./clients.ts";

const keyVariables = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"] as const;

test("with no provider key set, Clients has no client for anthropic, openai or xai: a request to one of them fails, naming the provider", async () => {
  const saved = keyVariables.map((name) => [name, process.env[name]] as const);
  for (const name of keyVariables) delete process.env[name];
  try {
    const failures = await runTest(
      Effect.forEach(["anthropic", "openai", "xai"], (provider) =>
        Effect.gen(function* () {
          const client = yield* ModelClient;
          const context = { system: undefined, tools: [], messages: [{ role: "user" as const, parts: [{ _tag: "Text" as const, text: "hi" }] }] };
          const exit = yield* Effect.exit(client.respond({ provider: ProviderName.make(provider), model: ModelName.make("any") }, context, TurnId.make("turn-1")));
          return Exit.isFailure(exit) ? String(Exit.isFailure(exit) && exit.cause) : "succeeded";
        }),
      ).pipe(Effect.provide(Clients), Effect.provideService(Report, () => Effect.void)),
    );
    expect(failures.map((failure) => /No request is configured for provider (\w+)/.exec(failure)?.[1])).toEqual(["anthropic", "openai", "xai"]);
  } finally {
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
  }
});
