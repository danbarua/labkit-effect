/** A tool call that waits for permission in the loop: what is asked and answered is recorded, and the answer decides whether it runs. */

import { expect } from "bun:test";
import { Effect, Layer, PubSub } from "effect";
import { BoringContextAssembler, BoringModelProvider, boringOpening } from "../../tests/support/boring.ts";
import { runTest } from "../../tests/support/run.ts";
import { smolCatalog, SmolToolRunner } from "../../tests/support/smol-tools.ts";
import { test } from "../../tests/support/test.ts";
import { CallId, ModelText, StopReason, ToolName } from "../agent-machine/names.ts";
import type { Observation } from "../agent-machine/observation.ts";
import { answerPicking, OptionId, permissions } from "../agent-policy/permissions.ts";
import type { Policy } from "../agent-policy/policy.ts";
import { ModelClient, ToolCallPolicy } from "./contracts.ts";
import { openSession } from "./loop.ts";
import { EphemeralSessionStore } from "./session-store.ts";
import { receivedJson } from "./received.ts";
import { CountingTurns, NoTurnEndHooks } from "./turns.ts";

/** A model that calls `echo` once, then answers. */
const callsEchoOnce = () => {
  let requests = 0;
  return Layer.succeed(ModelClient, {
    respond: (target, _context, turn) =>
      Effect.sync(() => {
        requests += 1;
        const parts =
          requests === 1
            ? [{ _tag: "ToolCall" as const, call: CallId.make("c1"), tool: ToolName.make("echo"), input: receivedJson({ text: "hi" }) }]
            : [{ _tag: "Text" as const, text: ModelText.make("done") }];
        return {
          _tag: "ModelResponded" as const,
          turn,
          provider: target.provider,
          model: target.model,
          parts,
          stop: StopReason.make("end_turn"),
          ending: { _tag: "Complete" as const },
          metadata: receivedJson({}),
        };
      }),
  });
};

/** A turn in which `echo` asks for permission and is answered with `option`; the observations recorded, by tag, and how the call ended. */
const answeredWith = (option: string) =>
  runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      const recorded = yield* session.subscribe;
      // The answerer: answers each question as it is recorded.
      yield* Effect.forkScoped(
        Effect.forever(
          PubSub.take(recorded).pipe(
            Effect.flatMap((fact) =>
              fact._tag === "Observed" && fact.observation._tag === "PermissionAsked"
                ? session.observe({ _tag: "PermissionAnswered", call: fact.observation.call, answer: answerPicking(OptionId.make(option)) })
                : Effect.void,
            ),
          ),
        ),
      );
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "echo hi" } as unknown as Observation);
      yield* session.idle;
      const observed = (yield* session.facts).flatMap((fact) => (fact._tag === "Observed" ? [fact.observation] : []));
      return {
        tags: observed.map((each) => each._tag).filter((tag) => ["PermissionAsked", "PermissionAnswered", "ToolCallDispatched", "ToolEnded"].includes(tag)),
        ended: observed.flatMap((each) => (each._tag === "ToolEnded" ? [each.outcome] : []))[0],
      };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          BoringContextAssembler,
          callsEchoOnce(),
          SmolToolRunner,
          CountingTurns,
          NoTurnEndHooks,
          Layer.succeed(ToolCallPolicy, (facts) => Effect.succeed(permissions("default", true, () => "other", facts) as Policy<unknown>)),
        ),
      ),
    ),
  );

test("P8: an allowed call runs after the answer; a rejected one ends Vetoed and never begins to run", async () => {
  const allowed = await answeredWith("allow-once");
  expect(allowed.tags).toEqual(["PermissionAsked", "PermissionAnswered", "ToolCallDispatched", "ToolEnded"]);
  expect(allowed.ended?._tag).toBe("Succeeded");
  const rejected = await answeredWith("reject-once");
  expect(rejected.tags).toEqual(["PermissionAsked", "PermissionAnswered", "ToolEnded"]);
  expect(rejected.ended as unknown).toMatchObject({ _tag: "Failed", reason: { _tag: "Vetoed" } });
});
