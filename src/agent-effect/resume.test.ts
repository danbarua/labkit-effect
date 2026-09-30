/**
 * A session that goes on from facts. The facts are made here with the core's driver, as a session
 * whose process ended would have left them: no record is read or written.
 */

import { expect } from "bun:test";
import { Effect, Layer } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import { ModelText, StopReason } from "../agent-core/names.ts";
import type { Observation } from "../agent-core/observation.ts";
import { WholeSessionAssembler } from "../../tests/support/boring.ts";
import { observe, open, opened, type Session as Driven } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";
import { runTest } from "../../tests/support/run.ts";
import { SmolToolRunner } from "../../tests/support/smol-tools.ts";
import { test } from "../../tests/support/test.ts";
import { ModelClient, type ModelContext } from "./contracts.ts";
import { endTurnLeftRunning, resumeSession, sessionFrom } from "./loop.ts";
import { ModelFromFacts } from "./model-choice.ts";
import { receivedJson } from "./received.ts";
import { countingTurnsAfter, NoTurnEndHooks } from "./turns.ts";

/** Facts up to a first request: the session opened, input given, a turn started, the model asked. */
function asked(): Driven {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "list the files" });
  return session;
}

const dispatched = { _tag: "ModelRequestDispatched", turn: "turn-1", provider: "boring", model: "boring-1" };
const call = { _tag: "ToolCall", call: "c1", tool: "ls", input: json({ path: "." }) };

/**
 * Goes on from `facts`, which hold `turns` turns, then gives `then` as input; the facts after, and
 * what the model was sent.
 */
const resumed = (facts: ReadonlyArray<Fact>, then?: string, turns = 1) => {
  const seen: Array<ModelContext> = [];
  const model = Layer.succeed(ModelClient, {
    respond: (target, context, turn) =>
      Effect.sync(() => {
        seen.push(context);
        return {
          _tag: "ModelResponded" as const,
          turn,
          provider: target.provider,
          model: target.model,
          parts: [{ _tag: "Text" as const, text: ModelText.make("Understood.") }],
          stop: StopReason.make("stop"),
          ending: { _tag: "Complete" as const },
          metadata: receivedJson({}),
        };
      }),
  });
  return runTest(
    Effect.gen(function* () {
      const session = yield* resumeSession(facts);
      const settled = yield* session.facts;
      if (then !== undefined) {
        yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: then } as unknown as Observation);
        yield* session.idle;
      }
      return { settled: settled.slice(facts.length), after: (yield* session.facts).slice(settled.length), seen };
    }).pipe(
      Effect.provide(
        // The facts hold `turns` turns: the turns that start now are counted on from them.
        Layer.mergeAll(ModelFromFacts, WholeSessionAssembler, model, countingTurnsAfter(turns), NoTurnEndHooks, SmolToolRunner),
      ),
    ),
  );
};

/** A model that is never to be asked. */
const NoModel = Layer.succeed(ModelClient, {
  respond: () => Effect.die(new Error("the model was asked")),
});

const tags = (facts: ReadonlyArray<Fact>) => facts.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));

test("X4: a model request was made and nothing came of it: no response was observed, the turn ends, and the session goes on", async () => {
  const session = asked();
  observe(session, dispatched);
  const { settled, after, seen } = await resumed(session.journal, "are you there?");
  expect(tags(settled)).toEqual(["TurnInterrupted", "ModelResponded", "TurnEnded"]);
  expect(settled[0] as unknown).toMatchObject({ origin: { _tag: "Harness", part: "resume" } });
  expect(settled[1] as unknown).toMatchObject({
    origin: { _tag: "Harness", part: "resume" },
    observation: { turn: "turn-1", provider: "boring", model: "boring-1", parts: [], ending: { _tag: "Indeterminate" } },
  });
  expect(settled[2] as unknown).toMatchObject({ decision: { turn: "turn-1", ending: { _tag: "Interrupted" } } });
  // The request is not made again. The next turn's request carries the unanswered input and the new.
  expect(tags(after)).toEqual([
    "InputArrived",
    "TurnStarted",
    "InputDelivered",
    "ModelAsked",
    "ModelRequestDispatched",
    "ModelResponded",
    "TurnEndReviewed",
    "TurnEnded",
  ]);
  expect(seen.map((context) => context.messages)).toEqual([
    [{ role: "user", parts: [{ _tag: "Text", text: "list the files" }, { _tag: "Text", text: "are you there?" }] }],
  ]);
});

test("X4: a tool was running: how it ended was not observed, and the model is told so with the next input", async () => {
  const session = asked();
  observe(session, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "boring",
    model: "boring-1",
    parts: [{ _tag: "Text", text: "Listing." }, call],
    ending: { _tag: "Complete" },
    metadata: json({}),
  });
  observe(session, { _tag: "ToolCallDispatched", call: "c1" });
  const { settled, seen } = await resumed(session.journal, "what did you find?");
  expect(tags(settled)).toEqual(["TurnInterrupted", "ToolEnded", "TurnEnded"]);
  expect(settled[1] as unknown).toMatchObject({
    observation: { call: "c1", outcome: { _tag: "Failed", reason: { _tag: "Indeterminate" } } },
  });
  expect(seen[0]?.messages as unknown).toEqual([
    { role: "user", parts: [{ _tag: "Text", text: "list the files" }] },
    { role: "assistant", parts: [{ _tag: "Text", text: "Listing." }, call] },
    {
      role: "user",
      parts: [
        { _tag: "ToolResult", call: "c1", outcome: { _tag: "Failed", reason: { _tag: "Indeterminate" } } },
        { _tag: "Text", text: "what did you find?" },
      ],
    },
  ]);
});

test("X4: a call had arrived while the response streamed: the response holds it, and the call has its result", async () => {
  const session = asked();
  observe(session, dispatched);
  observe(session, { _tag: "ToolCallArrived", turn: "turn-1", call: "c1", tool: "ls", input: json({ path: "." }) });
  observe(session, { _tag: "ToolCallDispatched", call: "c1" });
  const { settled, seen } = await resumed(session.journal, "go on");
  expect(tags(settled).slice(0, 1)).toEqual(["TurnInterrupted"]);
  expect(tags(settled).slice(1, 3).sort()).toEqual(["ModelResponded", "ToolEnded"]);
  expect(tags(settled).slice(3)).toEqual(["TurnEnded"]);
  expect(tags(settled)).not.toContain("ObservationNotExpected");
  expect(seen[0]?.messages.slice(1) as unknown).toEqual([
    { role: "assistant", parts: [call] },
    {
      role: "user",
      parts: [
        { _tag: "ToolResult", call: "c1", outcome: { _tag: "Failed", reason: { _tag: "Indeterminate" } } },
        { _tag: "Text", text: "go on" },
      ],
    },
  ]);
});

test("X4: facts that stop between turns are gone on from as they are; the next request carries the earlier turns", async () => {
  const session = asked();
  observe(session, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "boring",
    model: "boring-1",
    parts: [{ _tag: "Text", text: "a.ts and b.ts." }],
    ending: { _tag: "Complete" },
    metadata: json({}),
  });
  const { settled, after, seen } = await resumed(session.journal, "and the tests?");
  expect(settled).toEqual([]);
  expect(tags(after).at(-1)).toBe("TurnEnded");
  expect(after.find((fact) => fact._tag === "Observed" && fact.observation._tag === "TurnStarted") as unknown).toMatchObject({
    observation: { turn: "turn-2" },
  });
  expect(seen[0]?.messages as unknown).toEqual([
    { role: "user", parts: [{ _tag: "Text", text: "list the files" }] },
    { role: "assistant", parts: [{ _tag: "Text", text: "a.ts and b.ts." }] },
    { role: "user", parts: [{ _tag: "Text", text: "and the tests?" }] },
  ]);
});

test("X4: a session made from facts holds them as given; a turn they leave running stays so until it is ended", async () => {
  const driven = asked();
  observe(driven, dispatched);
  const { made, ended } = await runTest(
    Effect.gen(function* () {
      const session = yield* sessionFrom(driven.journal);
      const made = yield* session.facts;
      yield* endTurnLeftRunning(session, driven.journal);
      return { made, ended: (yield* session.facts).slice(made.length) };
    }).pipe(Effect.provide(Layer.mergeAll(ModelFromFacts, WholeSessionAssembler, NoModel, countingTurnsAfter(1), NoTurnEndHooks, SmolToolRunner))),
  );
  expect(made).toEqual(driven.journal);
  expect(tags(ended)).toEqual(["TurnInterrupted", "ModelResponded", "TurnEnded"]);
});

test("X4: a turn left running is ended though earlier turns came before it; only that turn's facts bear on the machines", async () => {
  const driven = asked();
  observe(driven, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "boring",
    model: "boring-1",
    parts: [{ _tag: "Text", text: "a.ts and b.ts." }],
    ending: { _tag: "Complete" },
    metadata: json({}),
  });
  observe(driven, { _tag: "InputArrived", from: { _tag: "User" }, text: "and the tests?" });
  observe(driven, { ...dispatched, turn: "turn-2" });
  const { settled, seen } = await resumed(driven.journal, "never mind the tests", 2);
  expect(tags(settled)).toEqual(["TurnInterrupted", "ModelResponded", "TurnEnded"]);
  expect(settled[2] as unknown).toMatchObject({ decision: { turn: "turn-2", ending: { _tag: "Interrupted" } } });
  expect(seen[0]?.messages as unknown).toEqual([
    { role: "user", parts: [{ _tag: "Text", text: "list the files" }] },
    { role: "assistant", parts: [{ _tag: "Text", text: "a.ts and b.ts." }] },
    { role: "user", parts: [{ _tag: "Text", text: "and the tests?" }, { _tag: "Text", text: "never mind the tests" }] },
  ]);
});
