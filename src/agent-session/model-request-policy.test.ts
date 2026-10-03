/** A model request policy in the loop: a request it holds is not made, and the turn fails, telling the user to wait. */

import { expect } from "bun:test";
import { Effect, Layer } from "effect";
import { BoringContextAssembler, BoringModelProvider, boringOpening } from "../../tests/support/boring.ts";
import { runTest } from "../../tests/support/run.ts";
import { smolCatalog, SmolToolRunner } from "../../tests/support/smol-tools.ts";
import { test } from "../../tests/support/test.ts";
import type { Observation } from "../agent-machine/observation.ts";
import type { Policy } from "../agent-policy/policy.ts";
import { ModelClient, ModelRequestPolicies } from "./contracts.ts";
import { openSession } from "./loop.ts";
import { harnessParts } from "./origin.ts";
import { receivedJson } from "./received.ts";
import { EphemeralSessionStore } from "./session-store.ts";
import { CountingTurns } from "./turns.ts";

/** Holds every model request, asking for the hour it may go on at. */
const holding: Policy<unknown> = {
  start: () => ({ _tag: "Waiting", state: undefined, asks: receivedJson({ until: "15:00" }) }),
  receive: (state) => ({ _tag: "Waiting", state, asks: undefined }),
};

test("P9: a request a policy holds is not made; the turn fails, saying to wait, with what the policy asks", async () => {
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "hi" } as unknown as Observation);
      yield* session.idle;
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          BoringContextAssembler,
          Layer.succeed(ModelClient, { respond: () => Effect.die(new Error("no request is made")) }),
          SmolToolRunner,
          CountingTurns,
          Layer.succeed(ModelRequestPolicies, [() => Effect.succeed(holding)]),
        ),
      ),
    ),
  );
  const observed = facts.flatMap((fact) => (fact._tag === "Observed" ? [{ origin: fact.origin, observation: fact.observation }] : []));
  expect(observed.some(({ observation }) => observation._tag === "ModelRequestDispatched")).toBe(false);
  expect(observed.filter(({ observation }) => observation._tag === "ModelFailed")).toMatchObject([
    { origin: harnessParts.modelRequestPolicy, observation: { failure: 'Not sent: a policy holds model requests for now. Wait, then try again. {"until":"15:00"}' } },
  ]);
  const ended = facts.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" ? [fact.decision.ending._tag] : []));
  expect(ended).toEqual(["Failed"]);
});
