/** A host drives turns through the session: `prompt` gives the user's input and returns how its turn ended, `cancel` interrupts the turn under way, `turn` says which it is. */

import { expect } from "bun:test";
import { Deferred, Effect, Exit, Fiber, Layer, PubSub, Ref } from "effect";
import { BoringContextAssembler, BoringModelProvider, boringOpening } from "../../tests/support/boring.ts";
import { runTest } from "../../tests/support/run.ts";
import { smolCatalog, SmolToolRunner } from "../../tests/support/smol-tools.ts";
import { test } from "../../tests/support/test.ts";
import { BlobId } from "../agent-machine/blob.ts";
import type { Decision } from "../agent-machine/decision.ts";
import type { Fact } from "../agent-machine/fact.ts";
import type { Observation } from "../agent-machine/observation.ts";
import { CallId, FailureText, InputText, ModelText, StopReason, ToolName, TurnId } from "../agent-machine/names.ts";
import { MediaType } from "../agent-machine/received.ts";
import { answerPicking, OptionId, permissions } from "../agent-policy/permissions.ts";
import type { Policy } from "../agent-policy/policy.ts";
import { ModelClient, ToolCallPolicies } from "./contracts.ts";
import { endTurnLeftRunning, openSession, type Prompt, type Session } from "./loop.ts";
import { receivedJson, receivedText } from "./received.ts";
import { EphemeralSessionStore, ephemeralSessionStore, SessionStore, SessionStoreFailed } from "./session-store.ts";
import { CountingTurns } from "./turns.ts";

/**
 * What the model does for each request, in order; past the end of the list it answers. `gate`
 * holds the request until it is completed; `holding` makes it refuse to stop meanwhile.
 */
type Reply =
  | { readonly _tag: "Answer"; readonly gate?: Deferred.Deferred<void>; readonly holding?: true }
  | { readonly _tag: "Fail" }
  | { readonly _tag: "CallEcho" };

const scripted = (replies: ReadonlyArray<Reply>) => {
  let requests = 0;
  return Layer.succeed(ModelClient, {
    respond: (target, _context, turn) =>
      Effect.suspend((): Effect.Effect<Extract<Observation, { _tag: "ModelResponded" | "ModelFailed" }>> => {
        const reply = replies[requests] ?? { _tag: "Answer" };
        requests += 1;
        if (reply._tag === "Fail")
          return Effect.succeed({ _tag: "ModelFailed" as const, turn, failure: FailureText.make("the model is down"), error: receivedText("503") });
        const parts =
          reply._tag === "CallEcho"
            ? [{ _tag: "ToolCall" as const, call: CallId.make("c1"), tool: ToolName.make("echo"), input: receivedJson({ text: "hi" }) }]
            : [{ _tag: "Text" as const, text: ModelText.make("done") }];
        const waited = reply._tag === "Answer" && reply.gate !== undefined ? Deferred.await(reply.gate) : Effect.void;
        return (reply._tag === "Answer" && reply.holding === true ? Effect.uninterruptible(waited) : waited).pipe(
          Effect.as({
            _tag: "ModelResponded" as const,
            turn,
            provider: target.provider,
            model: target.model,
            parts,
            stop: StopReason.make("end_turn"),
            ending: { _tag: "Complete" as const },
            metadata: receivedJson({}),
          }),
        );
      }),
  });
};

/** A policy that asks the user before every call; nothing here answers. */
const asking = Layer.succeed(ToolCallPolicies, [(facts) => Effect.succeed(permissions("default", true, () => "other", facts) as Policy<unknown>)]);

const services = (replies: ReadonlyArray<Reply>, policy: Layer.Layer<never> = Layer.empty) =>
  Layer.mergeAll(BoringModelProvider, BoringContextAssembler, scripted(replies), SmolToolRunner, CountingTurns, policy);
const said = (text: string): Prompt => ({ text: InputText.make(text) });

const tagOf = (fact: Fact): string => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag);
const tagsOf = (facts: ReadonlyArray<Fact>) => facts.map(tagOf);

/** A session over a store in memory, opened, with a subscription to what it records from here on. */
const opened = Effect.gen(function* () {
  const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
  const recorded = yield* session.subscribe;
  yield* session.observe(boringOpening(smolCatalog));
  return { session, recorded };
});

/** Waits until `times` facts tagged `tag` have been recorded through `recorded`. */
const seen = (recorded: PubSub.Subscription<Fact>, tag: string, times = 1) =>
  Effect.gen(function* () {
    let count = 0;
    while (count < times) if (tagOf(yield* PubSub.take(recorded)) === tag) count += 1;
  });

const decided = <T extends Decision["_tag"]>(facts: ReadonlyArray<Fact>, tag: T): ReadonlyArray<Extract<Decision, { _tag: T }>> =>
  facts.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === tag ? [fact.decision as Extract<Decision, { _tag: T }>] : []));

test("L1 L2: prompt with no turn under way starts one and returns how it ended; turn names it while it runs, and none after", async () => {
  const { during, ending, after, facts } = await runTest(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const { session, recorded } = yield* opened;
        const before = yield* session.turn;
        const attachment = { id: BlobId.make("a".repeat(64)), mediaType: MediaType.make("image/png"), size: 3 };
        const asked = yield* Effect.forkChild(session.prompt({ text: InputText.make("hello"), attachments: [attachment] }));
        yield* seen(recorded, "AskModel");
        const during = [before, yield* session.turn];
        yield* Deferred.succeed(gate, undefined);
        const ending = yield* Fiber.join(asked);
        return { during, ending, after: yield* session.turn, facts: yield* session.facts };
      }).pipe(Effect.provide(services([{ _tag: "Answer", gate }])));
    }),
  );
  expect(during).toEqual([undefined, TurnId.make("turn-1")]);
  expect(ending).toEqual({ _tag: "Completed" });
  expect(after).toBeUndefined();
  const input = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "InputArrived");
  expect(input as unknown).toMatchObject({
    origin: { _tag: "Test" },
    observation: { from: { _tag: "User" }, text: "hello", attachments: [{ mediaType: "image/png", size: 3 }] },
  });
});

test("L2: while prompt waits the session takes observations: a permission question its turn asks is answered from another fiber", async () => {
  const { ending, ended } = await runTest(
    Effect.gen(function* () {
      const { session, recorded } = yield* opened;
      const asked = yield* Effect.forkChild(session.prompt(said("echo hi")));
      yield* seen(recorded, "PermissionAsked");
      yield* session.observe({ _tag: "PermissionAnswered", call: CallId.make("c1"), answer: answerPicking(OptionId.make("allow-once")) });
      const ending = yield* Fiber.join(asked);
      const facts = yield* session.facts;
      return { ending, ended: facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === "ToolEnded" ? [fact.observation.outcome._tag] : [])) };
    }).pipe(Effect.provide(services([{ _tag: "CallEcho" }], asking))),
  );
  expect(ending).toEqual({ _tag: "Completed" });
  expect(ended).toEqual(["Succeeded"]);
});

test("L3: two prompts at once go to one turn: the first starts it, the second is taken between steps, and both return its ending", async () => {
  const { endings, facts } = await runTest(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const { session, recorded } = yield* opened;
        const both = yield* Effect.forkChild(Effect.all([session.prompt(said("first")), session.prompt(said("second"))], { concurrency: "unbounded" }));
        yield* seen(recorded, "InputArrived", 2);
        yield* Deferred.succeed(gate, undefined);
        return { endings: yield* Fiber.join(both), facts: yield* session.facts };
      }).pipe(Effect.provide(services([{ _tag: "Answer", gate }])));
    }),
  );
  expect(endings).toEqual([{ _tag: "Completed" }, { _tag: "Completed" }]);
  expect(tagsOf(facts).filter((tag) => tag === "TurnStarted")).toHaveLength(1);
  expect(decided(facts, "InputDelivered").map((each) => [each.turn, each.inputs.length])).toEqual([
    [TurnId.make("turn-1"), 1],
    [TurnId.make("turn-1"), 1],
  ]);
  // The second was taken after the model's first answer, and the model was asked again.
  expect(tagsOf(facts).filter((tag) => tag === "AskModel" || tag === "TellModel")).toEqual(["AskModel", "TellModel"]);
});

test("L3 L5: a cancelled turn drops a prompt's input still queued; both prompts return Interrupted, and the next prompt starts a turn", async () => {
  const { endings, next, facts } = await runTest(
    Effect.gen(function* () {
      const never = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const { session, recorded } = yield* opened;
        const first = yield* Effect.forkChild(session.prompt(said("first")));
        yield* seen(recorded, "AskModel");
        const second = yield* Effect.forkChild(session.prompt(said("second")));
        yield* seen(recorded, "InputArrived");
        yield* session.cancel;
        const endings = [yield* Fiber.join(first), yield* Fiber.join(second)];
        const next = yield* session.prompt(said("third"));
        return { endings, next, facts: yield* session.facts };
      }).pipe(Effect.provide(services([{ _tag: "Answer", gate: never }])));
    }),
  );
  expect(endings).toEqual([{ _tag: "Interrupted" }, { _tag: "Interrupted" }]);
  expect(decided(facts, "InputDropped").map((each) => [each.turn, each.inputs.length])).toEqual([[TurnId.make("turn-1"), 1]]);
  expect(next).toEqual({ _tag: "Completed" });
  expect(decided(facts, "TurnEnded").map((each) => each.turn)).toEqual([TurnId.make("turn-1"), TurnId.make("turn-2")]);
});

test("L4: prompt after a turn that failed starts a new turn and returns how that one ended", async () => {
  const { endings, facts } = await runTest(
    Effect.gen(function* () {
      const { session } = yield* opened;
      const endings = [yield* session.prompt(said("one")), yield* session.prompt(said("two"))];
      return { endings, facts: yield* session.facts };
    }).pipe(Effect.provide(services([{ _tag: "Fail" }]))),
  );
  expect(endings).toEqual([{ _tag: "Failed", failure: FailureText.make("the model is down") }, { _tag: "Completed" }]);
  expect(facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === "TurnStarted" ? [fact.observation.turn] : []))).toEqual([
    TurnId.make("turn-1"),
    TurnId.make("turn-2"),
  ]);
});

test("L5: cancel with no turn under way records nothing, before the first turn and after one", async () => {
  const { counts } = await runTest(
    Effect.gen(function* () {
      const { session } = yield* opened;
      const counts: Array<number> = [];
      for (const step of [Effect.void, session.prompt(said("hello")).pipe(Effect.asVoid)]) {
        yield* step;
        const before = (yield* session.facts).length;
        yield* session.cancel;
        counts.push((yield* session.facts).length - before);
      }
      return { counts };
    }).pipe(Effect.provide(services([]))),
  );
  expect(counts).toEqual([0, 0]);
});

test("L5: cancel returns once TurnInterrupted is recorded; the turn ends Interrupted when its request has reported how far it got", async () => {
  const { atCancel, ending, after } = await runTest(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const { session, recorded } = yield* opened;
        const asked = yield* Effect.forkChild(session.prompt(said("hello")));
        yield* seen(recorded, "ModelRequestDispatched");
        yield* session.cancel;
        const atCancel = { turn: yield* session.turn, tags: tagsOf(yield* session.facts) };
        // The model's request does not stop until it is let go: the turn waits to hear how far it got.
        yield* Deferred.succeed(gate, undefined);
        const ending = yield* Fiber.join(asked);
        return { atCancel, ending, after: yield* session.turn };
      }).pipe(Effect.provide(services([{ _tag: "Answer", gate, holding: true }])));
    }),
  );
  expect(atCancel.turn).toBe(TurnId.make("turn-1"));
  expect(atCancel.tags).toContain("TurnInterrupted");
  expect(atCancel.tags).not.toContain("TurnEnded");
  expect(ending).toEqual({ _tag: "Interrupted" });
  expect(after).toBeUndefined();
});

test("L5: cancel while a call waits for a permission answer: the call ends NotRun without running, the question is dropped, and prompt returns Interrupted", async () => {
  const { ending, observed } = await runTest(
    Effect.gen(function* () {
      const { session, recorded } = yield* opened;
      const asked = yield* Effect.forkChild(session.prompt(said("echo hi")));
      yield* seen(recorded, "PermissionAsked");
      yield* session.cancel;
      const ending = yield* Fiber.join(asked);
      // Nothing is left waiting for an answer.
      yield* session.idle;
      return { ending, observed: (yield* session.facts).flatMap((fact) => (fact._tag === "Observed" ? [fact.observation] : [])) };
    }).pipe(Effect.provide(services([{ _tag: "CallEcho" }], asking))),
  );
  expect(ending).toEqual({ _tag: "Interrupted" });
  expect(observed.map((each) => each._tag)).not.toContain("ToolCallDispatched");
  expect(observed.flatMap((each) => (each._tag === "ToolEnded" ? [each.outcome] : []))).toEqual([{ _tag: "Failed", reason: { _tag: "NotRun" } }]);
});

test("J3: a write that fails while prompt waits fails prompt with the reason, and cancel after it too", async () => {
  // A store whose write of a model request's dispatch fails.
  const failing = Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const kept = yield* Ref.make<ReadonlyArray<Fact>>([]);
      return {
        facts: Ref.get(kept),
        append: (more: ReadonlyArray<Fact>) =>
          more.some((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelRequestDispatched")
            ? Effect.fail(new SessionStoreFailed({ message: "the disk is full" }))
            : Ref.update(kept, (before) => [...before, ...more]),
      };
    }),
  );
  const { asked, cancelled } = await runTest(
    Effect.gen(function* () {
      const session: Session = yield* openSession;
      yield* session.observe(boringOpening());
      const asked = yield* Effect.exit(session.prompt(said("hello")));
      const cancelled = yield* Effect.exit(session.cancel);
      return { asked, cancelled };
    }).pipe(Effect.provide(Layer.merge(services([]), failing))),
  );
  expect(Exit.isFailure(asked) ? String(asked.cause) : "").toContain("the disk is full");
  expect(Exit.isFailure(cancelled) ? String(cancelled.cause) : "").toContain("the disk is full");
});

test("L1: a turn the facts left running is under way in the session that goes on from them, until the host ends it", async () => {
  const { left, ended } = await runTest(
    Effect.gen(function* () {
      const never = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const facts = yield* Effect.scoped(
          Effect.gen(function* () {
            const { session, recorded } = yield* opened;
            yield* Effect.forkChild(session.prompt(said("hello")));
            yield* seen(recorded, "ModelRequestDispatched");
            return yield* session.facts;
          }),
        );
        const after = yield* openSession.pipe(Effect.provide(ephemeralSessionStore(facts)));
        const left = yield* after.turn;
        yield* endTurnLeftRunning(after);
        return { left, ended: yield* after.turn };
      }).pipe(Effect.provide(services([{ _tag: "Answer", gate: never }])));
    }),
  );
  expect(left).toBe(TurnId.make("turn-1"));
  expect(ended).toBeUndefined();
});
