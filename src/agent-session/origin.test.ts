/** Every recorded observation says where it came from. */

import { expect } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import { CallId, ModelText, StopReason, ToolName } from "../agent-machine/names.ts";
import type { Observation } from "../agent-machine/observation.ts";
import { ModelClient } from "./contracts.ts";
import { openSession } from "./loop.ts";
import { EphemeralSessionStore } from "./session-store.ts";
import { receivedJson } from "./received.ts";
import { TurnContextAssembler } from "./turn-context.ts";
import { CountingTurns } from "./turns.ts";
import { BoringModelProvider, boringOpening } from "../../tests/support/boring.ts";
import { runTest } from "../../tests/support/run.ts";
import { SmolToolRunner, smolCatalog } from "../../tests/support/smol-tools.ts";
import { test } from "../../tests/support/test.ts";

/** A model that calls `add` once, then answers. */
const scripted = () => {
  let asked = 0;
  return Layer.succeed(ModelClient, {
    respond: (target, _context, turn) =>
      Effect.sync(() => ({
        _tag: "ModelResponded" as const,
        turn,
        provider: target.provider,
        model: target.model,
        parts:
          ++asked === 1
            ? [{ _tag: "ToolCall" as const, call: CallId.make("call-1"), tool: ToolName.make("add"), input: receivedJson({ a: 2, b: 3 }) }]
            : [{ _tag: "Text" as const, text: ModelText.make("5.") }],
        stop: StopReason.make("stop"),
        ending: { _tag: "Complete" as const },
        metadata: receivedJson({}),
      })),
  });
};

const services = () =>
  Layer.mergeAll(BoringModelProvider, TurnContextAssembler, scripted(), CountingTurns, SmolToolRunner);

const input = { _tag: "InputArrived", from: { _tag: "User" }, text: "What is 2 + 3?" } as unknown as Observation;

test("R6: what the test gives the session is from the test; what the loop observes is from the provider, the tool or the harness", async () => {
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.idle;
      yield* session.observe(input);
      yield* session.idle;
      return yield* session.facts;
    }).pipe(Effect.provide(services())),
  );
  const name = "R6: what the test gives the session is from the test; what the loop observes is from the provider, the tool or the harness";
  const origins = facts.flatMap((fact) => (fact._tag === "Observed" ? [[fact.observation._tag, fact.origin]] : []));
  expect(origins as unknown).toEqual([
    ["SessionOpened", { _tag: "Test", name }],
    ["InputArrived", { _tag: "Test", name }],
    ["TurnStarted", { _tag: "Harness", part: "loop" }],
    ["ModelRequestDispatched", { _tag: "Harness", part: "loop" }],
    ["ModelResponded", { _tag: "Provider", provider: "boring" }],
    ["ToolCallDispatched", { _tag: "Harness", part: "tool runner" }],
    ["ToolEnded", { _tag: "Tool", tool: "add" }],
    ["ModelRequestDispatched", { _tag: "Harness", part: "loop" }],
    ["ModelResponded", { _tag: "Provider", provider: "boring" }],
    ["TurnEndReviewed", { _tag: "Harness", part: "turn-end hooks" }],
  ]);
});

test("R6: an observation given to a session with no origin set is a defect", async () => {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(boringOpening());
      yield* session.idle;
    }).pipe(Effect.provide(services()), Effect.scoped),
  );
  expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("SessionOpened was given to a session with no origin set");
});
