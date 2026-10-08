/** The loop breaker in the loop: a model that repeats a call is told so, then its turn is stopped by a model request policy. */

import { userInput } from "../../tests/support/observations.ts";
import { expect } from "bun:test";
import { Effect, Layer, Logger } from "effect";
import { BoringContextAssembler, BoringModelProvider, boringOpening } from "../../tests/support/boring.ts";
import { runTest } from "../../tests/support/run.ts";
import { smolCatalog, SmolToolRunner } from "../../tests/support/smol-tools.ts";
import { test } from "../../tests/support/test.ts";
import { CallId, StopReason, ToolName } from "../agent-machine/names.ts";
import { repeatedCalls, repeatingTurns } from "../agent-policy/loop-breaker.ts";
import { ModelClient, ModelRequestPolicies, ToolCallPolicies } from "./contracts.ts";
import { openSession } from "./loop.ts";
import { policyPart } from "./origin.ts";
import { asText, receivedJson } from "./received.ts";
import { EphemeralSessionStore } from "./session-store.ts";
import { CountingTurns } from "./turns.ts";

/** A model that calls `echo` with the same input at every request. */
const repeatsEcho = () => {
  let requests = 0;
  return Layer.succeed(ModelClient, {
    respond: (target, _context, turn) =>
      Effect.sync(() => {
        requests += 1;
        return {
          _tag: "ModelResponded" as const,
          turn,
          provider: target.provider,
          model: target.model,
          parts: [{ _tag: "ToolCall" as const, call: CallId.make(`c${requests}`), tool: ToolName.make("echo"), input: receivedJson({ text: "hi" }) }],
          stop: StopReason.make("tool_use"),
          ending: { _tag: "Complete" as const },
          metadata: receivedJson({}),
        };
      }),
  });
};

test("calls 1 and 2 run, calls 3 to 5 are vetoed with a reason the model reads, and the next model request is vetoed, ending the turn Vetoed; each veto is recorded and logged with the name of the policy that made it", async () => {
  const logged: Array<unknown> = [];
  const capture = Logger.make((options) => {
    logged.push(options.message);
  });
  const observed = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.observe(userInput("echo hi"));
      yield* session.idle;
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          BoringContextAssembler,
          repeatsEcho(),
          SmolToolRunner,
          CountingTurns,
          Layer.succeed(ToolCallPolicies, [{ name: "loopBreaker", policy: (facts) => Effect.succeed(repeatedCalls(facts)) }]),
          Layer.succeed(ModelRequestPolicies, [{ name: "loopBreaker", policy: (facts) => Effect.succeed(repeatingTurns(facts)) }]),
          Logger.layer([capture], { mergeWithExisting: true }),
        ),
      ),
    ),
  );
  const ended = observed.flatMap((fact) =>
    fact._tag === "Observed" && fact.observation._tag === "ToolEnded" ? [fact.observation.outcome] : [],
  );
  expect(ended.map((outcome) => (outcome._tag === "Failed" ? outcome.reason._tag : outcome._tag))).toEqual(["Succeeded", "Succeeded", "Vetoed", "Vetoed", "Vetoed"]);
  const third = ended[2];
  expect(third?._tag === "Failed" && third.reason._tag === "Vetoed" ? asText(third.reason.reason) : undefined).toStartWith(
    "Not run: echo has been called with this same input 3 times in a row.",
  );
  // Five requests were made; the sixth was vetoed before it was made.
  const dispatched = observed.filter((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelRequestDispatched");
  expect(dispatched.length).toBe(5);
  const vetoed = observed.flatMap((fact) =>
    fact._tag === "Observed" && fact.observation._tag === "ModelVetoed" ? [{ origin: fact.origin, reason: asText(fact.observation.reason) }] : [],
  );
  expect(vetoed).toEqual([{ origin: policyPart("model request policy", "loopBreaker"), reason: "Stopped: echo was called with the same input 5 times in a row." }]);
  const vetoedCalls = observed.flatMap((fact) =>
    fact._tag === "Observed" && fact.observation._tag === "ToolEnded" && fact.observation.outcome._tag === "Failed" ? [fact.origin] : [],
  );
  expect(vetoedCalls).toEqual([0, 1, 2].map(() => policyPart("tool call policy", "loopBreaker")));
  const vetoes = logged.flat().filter((each): each is { readonly by: string } => typeof each === "object" && each !== null && "by" in each);
  expect(vetoes.map((each) => each.by)).toEqual(["loopBreaker", "loopBreaker", "loopBreaker", "loopBreaker"]);
  const turnEnded = observed.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" ? [fact.decision.ending._tag] : []));
  expect(turnEnded).toEqual(["Vetoed"]);
});
