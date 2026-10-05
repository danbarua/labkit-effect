/** `retryIncomplete`: a turn whose response had thinking but no answer is asked again for it. */

import { expect } from "bun:test";
import { Effect, Layer } from "effect";
import { BoringContextAssembler, BoringModelProvider, boringOpening } from "../../tests/support/boring.ts";
import { runTest } from "../../tests/support/run.ts";
import { SmolToolRunner } from "../../tests/support/smol-tools.ts";
import { test } from "../../tests/support/test.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { InputText, ModelText, ThinkingText } from "../agent-machine/names.ts";
import type { Observation } from "../agent-machine/observation.ts";
import { MaxHolds, ModelClient, type ModelContext, TurnEndHooks } from "../agent-session/contracts.ts";
import { openSession } from "../agent-session/loop.ts";
import { receivedJson } from "../agent-session/received.ts";
import { EphemeralSessionStore } from "../agent-session/session-store.ts";
import { CountingTurns } from "../agent-session/turns.ts";
import { answerNow, retryIncomplete } from "./incomplete.ts";

/** What the model gives each request, in order: its thinking alone, its answer, or its thinking cut short. */
type Reply = "thinks" | "answers" | "cut";

/** A model that gives `replies` in order and keeps what each request was sent. */
const scripted = (replies: ReadonlyArray<Reply>) => {
  const sent: Array<ModelContext> = [];
  const layer = Layer.succeed(ModelClient, {
    respond: (target, context, turn) =>
      Effect.sync((): Extract<Observation, { _tag: "ModelResponded" }> => {
        const reply = replies[sent.length];
        sent.push(context);
        if (reply === undefined) throw new Error("the script has no more replies");
        return {
          _tag: "ModelResponded",
          turn,
          provider: target.provider,
          model: target.model,
          parts:
            reply === "answers"
              ? [{ _tag: "Text", text: ModelText.make("4") }]
              : [{ _tag: "Thinking", text: ThinkingText.make("2 + 2 is 4."), received: receivedJson({ thinking: "2 + 2 is 4." }) }],
          ending: reply === "cut" ? { _tag: "CutShort" } : { _tag: "Complete" },
          metadata: receivedJson({}),
        };
      }),
  });
  return { layer, sent };
};

/**
 * `prompts` prompts through the loop with `retryIncomplete(retries)` as its hook, held at most `retries` times: how
 * each ended, the facts, and each request's messages' text.
 */
const prompted = async (replies: ReadonlyArray<Reply>, retries = 1, prompts = 1) => {
  const model = scripted(replies);
  const hooks = Layer.mergeAll(Layer.succeed(TurnEndHooks, [retryIncomplete(retries)]), Layer.succeed(MaxHolds, retries));
  const services = Layer.mergeAll(BoringModelProvider, BoringContextAssembler, model.layer, SmolToolRunner, CountingTurns, hooks).pipe(
    Layer.provideMerge(EphemeralSessionStore),
  );
  const { endings, facts } = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening());
      const endings = yield* Effect.forEach(Array.from({ length: prompts }), () => session.prompt({ text: InputText.make("What is 2 + 2?") }));
      return { endings, facts: yield* session.facts };
    }).pipe(Effect.provide(services)),
  );
  const texts = model.sent.map((context) => context.messages.flatMap((message) => message.parts.flatMap((part) => (part._tag === "Text" ? [part.text] : []))));
  return { ending: endings[0], endings, facts, texts };
};

const fromSystem = (facts: ReadonlyArray<Fact>) =>
  facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === "InputArrived" && fact.observation.from._tag === "System" ? [fact.observation.text] : []));

/** The loop records this, and warns, when a turn has been held as many times as it may and a hook would hold it again. */
const exhausted = (facts: ReadonlyArray<Fact>) => facts.some((fact) => fact._tag === "Observed" && fact.observation._tag === "TurnHoldsExhausted");

test("a response with thinking but no answer is followed by the feedback and a second request, whose answer completes the turn without the loop's holds running out", async () => {
  const { ending, facts, texts } = await prompted(["thinks", "answers"]);
  expect(ending).toEqual({ _tag: "Completed" });
  expect(fromSystem(facts)).toEqual([InputText.make(answerNow)]);
  expect(texts).toEqual([["What is 2 + 2?"], ["What is 2 + 2?", answerNow]]);
  expect(exhausted(facts)).toBe(false);
});

test("a second response with no answer ends the turn Incomplete after one retry, with no third request and without the loop's holds running out", async () => {
  const { ending, facts, texts } = await prompted(["thinks", "thinks"]);
  expect(ending).toEqual({ _tag: "Incomplete" });
  expect(texts).toHaveLength(2);
  expect(fromSystem(facts)).toEqual([InputText.make(answerNow)]);
  expect(exhausted(facts)).toBe(false);
});

test("the retries asked for are made: two retries answer on the third request, and a turn that never answers ends Incomplete after the third", async () => {
  const answered = await prompted(["thinks", "thinks", "answers"], 2);
  expect(answered.ending).toEqual({ _tag: "Completed" });
  expect(answered.texts).toHaveLength(3);
  expect(fromSystem(answered.facts)).toEqual([InputText.make(answerNow), InputText.make(answerNow)]);
  const never = await prompted(["thinks", "thinks", "thinks"], 2);
  expect(never.ending).toEqual({ _tag: "Incomplete" });
  expect(never.texts).toHaveLength(3);
  expect(exhausted(never.facts)).toBe(false);
});

test("each turn has its own retries", async () => {
  const { endings, facts, texts } = await prompted(["thinks", "answers", "thinks", "answers"], 1, 2);
  expect(endings).toEqual([{ _tag: "Completed" }, { _tag: "Completed" }]);
  expect(texts).toHaveLength(4);
  expect(fromSystem(facts)).toEqual([InputText.make(answerNow), InputText.make(answerNow)]);
});

test("an answered turn and a response cut short get no feedback", async () => {
  const answered = await prompted(["answers"]);
  expect(answered.ending).toEqual({ _tag: "Completed" });
  expect(answered.texts).toHaveLength(1);
  expect(fromSystem(answered.facts)).toEqual([]);
  const cut = await prompted(["cut"]);
  expect(cut.ending).toEqual({ _tag: "CutShort" });
  expect(cut.texts).toHaveLength(1);
  expect(fromSystem(cut.facts)).toEqual([]);
});
