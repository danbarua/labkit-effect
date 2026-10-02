/**
 * Going on with a turn that facts left running: each request they left with no outcome is carried
 * out. The facts are made with the core's driver, as a process that ended mid-turn would have left
 * them; the session goes on from them through the loop.
 */

import { expect } from "bun:test";
import { Effect, Layer, PubSub } from "effect";
import { BoringModelProvider, boringOpening, WholeSessionAssembler } from "../../tests/support/boring.ts";
import { observe, open, type DrivenMachines } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { leftRunning } from "../agent-machine/left-running.ts";
import { ModelText, StopReason, ToolName } from "../agent-machine/names.ts";
import { answerPicking, OptionId, permissions } from "../agent-policy/permissions.ts";
import type { Policy } from "../agent-policy/policy.ts";
import { ModelClient, ToolCallPolicy, ToolRunner, type ToolSpec } from "./contracts.ts";
import { openSession } from "./loop.ts";
import { receivedJson, receivedText } from "./received.ts";
import { ephemeralSessionStore } from "./session-store.ts";
import { CountingTurnsInStore, NoTurnEndHooks } from "./turns.ts";

/** `look` changes nothing; `write` leaves things as writing once does; `launch` cannot be run twice. */
const catalog: ReadonlyArray<ToolSpec> = [
  { name: ToolName.make("look"), description: "Looks.", input: { type: "object" }, kind: "read", replay: "safe" },
  { name: ToolName.make("write"), description: "Writes.", input: { type: "object" }, kind: "edit", replay: "idempotent" },
  { name: ToolName.make("launch"), description: "Launches.", input: { type: "object" }, kind: "execute", replay: "unsafe" },
];

/** A session asking the boring model, with `look` and `launch`, in which "go" was given and the model asked. */
function asked(): DrivenMachines {
  const session = open();
  observe(session, boringOpening(catalog));
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "go" });
  observe(session, { _tag: "ModelRequestDispatched", turn: "turn-1", provider: "boring", model: "boring-1", sent: json({ messages: [] }) });
  return session;
}

/** The model calls `tool` as call c1. */
const calls = (session: DrivenMachines, tool: string) =>
  observe(session, {
    _tag: "ModelResponded",
    turn: "turn-1",
    provider: "boring",
    model: "boring-1",
    parts: [{ _tag: "ToolCall", call: "c1", tool, input: json({}) }],
    ending: { _tag: "Complete" },
    metadata: json({}),
  });

/** Goes on from `facts`: the facts recorded from then on, which tools ran, and how many times the model was asked. */
const wentOn = (facts: ReadonlyArray<Fact>) => {
  const ran: Array<string> = [];
  const asked = { count: 0 };
  const model = Layer.succeed(ModelClient, {
    respond: (target, _context, turn) =>
      Effect.sync(() => {
        asked.count += 1;
        return {
          _tag: "ModelResponded" as const,
          turn,
          provider: target.provider,
          model: target.model,
          parts: [{ _tag: "Text" as const, text: ModelText.make("done") }],
          stop: StopReason.make("end_turn"),
          ending: { _tag: "Complete" as const },
          metadata: receivedJson({}),
        };
      }),
  });
  const tools = Layer.succeed(ToolRunner, {
    run: (tool) => Effect.sync(() => ran.push(tool)).pipe(Effect.as({ _tag: "Succeeded" as const, output: receivedText("ok") })),
  });
  const store = ephemeralSessionStore(facts);
  return runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      // Whoever is asked before a call runs allows it.
      const recorded = yield* session.subscribe;
      yield* Effect.forkScoped(
        Effect.forever(
          PubSub.take(recorded).pipe(
            Effect.flatMap((fact) =>
              fact._tag === "Observed" && fact.observation._tag === "PermissionAsked"
                ? session.observe({ _tag: "PermissionAnswered", call: fact.observation.call, answer: answerPicking(OptionId.make("allow-once")) })
                : Effect.void,
            ),
          ),
        ),
      );
      yield* session.goOn;
      yield* session.idle;
      return { after: (yield* session.facts).slice(facts.length), ran, asked: asked.count };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          WholeSessionAssembler,
          model,
          tools,
          NoTurnEndHooks,
          CountingTurnsInStore,
          Layer.succeed(ToolCallPolicy, (held) => Effect.succeed(permissions("default", true, (name) => catalog.find((tool) => tool.name === name)?.kind, held) as Policy<unknown>)),
        ).pipe(Layer.provideMerge(store)),
      ),
    ),
  );
};

const tags = (facts: ReadonlyArray<Fact>) => facts.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));
const ending = (facts: ReadonlyArray<Fact>) => facts.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" ? [fact.decision.ending._tag] : []));

test("X5 J5: a model request made and not answered is made again, and the turn goes on", async () => {
  const session = asked();
  expect(leftRunning(session.journal)?.requests.map((request) => request._tag)).toEqual(["RequestModelResponse"]);
  const { after, asked: times } = await wentOn(session.journal);
  expect(times).toBe(1);
  expect(tags(after).slice(0, 2)).toEqual(["ModelRequestDispatched", "ModelResponded"]);
  expect(ending(after)).toEqual(["Completed"]);
});

test("X5: a call that began, to a tool safe to run again, runs again; the model is told how it ended", async () => {
  const session = asked();
  calls(session, "look");
  observe(session, { _tag: "ToolCallDispatched", call: "c1" });
  expect([...(leftRunning(session.journal)?.began ?? [])] as Array<string>).toEqual(["c1"]);
  const { after, ran, asked: times } = await wentOn(session.journal);
  expect(ran).toEqual(["look"]);
  expect(after.find((fact) => fact._tag === "Observed" && fact.observation._tag === "ToolEnded") as unknown).toMatchObject({
    observation: { call: "c1", outcome: { _tag: "Succeeded" } },
  });
  expect(times).toBe(1);
  expect(ending(after)).toEqual(["Completed"]);
});

test.each([["launch"], ["write"]])("X5: a call that began, to a tool that changes things (%s), is not run again: how it ended was not observed", async (tool: string) => {
  const session = asked();
  calls(session, tool);
  observe(session, { _tag: "ToolCallDispatched", call: "c1" });
  const { after, ran, asked: times } = await wentOn(session.journal);
  expect(ran).toEqual([]);
  expect(after[0] as unknown).toMatchObject({
    origin: { _tag: "Harness", part: "resume" },
    observation: { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Failed", reason: { _tag: "Indeterminate" } } },
  });
  expect(times).toBe(1);
  expect(ending(after)).toEqual(["Completed"]);
});

test("X5: a call that had not begun, waiting for an answer, is asked about again and runs once allowed", async () => {
  const session = asked();
  calls(session, "launch");
  observe(session, { _tag: "PermissionAsked", call: "c1", asks: json({ tool: "launch" }) });
  const { after, ran } = await wentOn(session.journal);
  expect(tags(after).slice(0, 3)).toEqual(["PermissionAsked", "PermissionAnswered", "ToolCallDispatched"]);
  expect(ran).toEqual(["launch"]);
  expect(ending(after)).toEqual(["Completed"]);
});

test("X5 X4: a turn that was being interrupted is given what is known of each request, and ends; nothing runs", async () => {
  const session = asked();
  calls(session, "look");
  observe(session, { _tag: "ToolCallDispatched", call: "c1" });
  observe(session, { _tag: "TurnInterrupted", turn: "turn-1" });
  expect(leftRunning(session.journal)?.stopping).toBe(true);
  const { after, ran, asked: times } = await wentOn(session.journal);
  expect(ran).toEqual([]);
  expect(times).toBe(0);
  expect(after[0] as unknown).toMatchObject({ observation: { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Failed", reason: { _tag: "Indeterminate" } } } });
  expect(ending(after)).toEqual(["Interrupted"]);
});

test("X5: input that arrived with no turn started for it starts one", async () => {
  const session = open();
  session.startsTurns = false;
  observe(session, boringOpening(catalog));
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "go" });
  expect(leftRunning(session.journal)).toBeUndefined();
  const { after, asked: times } = await wentOn(session.journal);
  expect(tags(after)[0]).toBe("TurnStarted");
  expect(times).toBe(1);
  expect(ending(after)).toEqual(["Completed"]);
});
