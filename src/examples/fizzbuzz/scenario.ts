/**
 * Plays a FizzBuzz conversation through the loop: the session opens asking the scripted model, with
 * the FizzBuzz system prompt and the setup's tool catalog recorded; each input the user sends is
 * observed, and the loop carries out everything that follows. The result is the session's facts and
 * every context the model was sent.
 */

import { Effect, Layer } from "effect";
import {
  type Conversation,
  Notices,
  opening,
  SystemPrompts,
  type ToolCatalog,
  ToolCatalogs,
} from "../../agent-context/assemble.ts";
import { AgentContextAssembler, WholeConversation } from "../../agent-context/assembler.ts";
import type { Fact } from "../../agent-core/fact.ts";
import { InputText, ModelName, ProviderName, SessionId } from "../../agent-core/names.ts";
import type { ModelContext, ToolRunner } from "../../agent-effect/contracts.ts";
import { openSession } from "../../agent-effect/loop.ts";
import { ModelFromFacts } from "../../agent-effect/model-choice.ts";
import { CountingTurns, NoTurnEndHooks } from "../../agent-effect/turns.ts";
import { scriptedFizzBuzzModel } from "./model.ts";
import { FizzBuzzSystemPromptProvider } from "./prompt.ts";
import { AdvancedFizzBuzzToolCatalog, FizzBuzzToolCatalog, FizzBuzzToolRunner } from "./tools.ts";

/** A user who counts: `count` messages, each the number after the one the model should have returned. */
export const countingUser = (count: number): ReadonlyArray<string> =>
  Array.from({ length: count }, (_, index) => String(2 * index + 1));

export interface Setup {
  readonly catalog: ToolCatalog;
  /** How the conversation is viewed for each request. */
  readonly conversation: Layer.Layer<Conversation>;
  /** Runs the tools; the FizzBuzz runner when not given. */
  readonly tools?: Layer.Layer<ToolRunner>;
  /** The session's id; "fizzbuzz" when not given. */
  readonly session?: string;
}

export const basic: Setup = { catalog: FizzBuzzToolCatalog, conversation: WholeConversation };

export const advanced: Setup = { catalog: AdvancedFizzBuzzToolCatalog, conversation: WholeConversation };

export interface Played {
  readonly facts: ReadonlyArray<Fact>;
  readonly seen: ReadonlyArray<ModelContext>;
}

export const play = (inputs: ReadonlyArray<string>, setup: Setup = basic): Effect.Effect<Played> => {
  const model = scriptedFizzBuzzModel();
  const services = Layer.mergeAll(
    ModelFromFacts,
    model.layer,
    AgentContextAssembler.pipe(Layer.provide(Layer.mergeAll(setup.conversation, Layer.succeed(Notices, [])))),
    CountingTurns,
    NoTurnEndHooks,
    setup.tools ?? FizzBuzzToolRunner,
    Layer.succeed(SystemPrompts, [FizzBuzzSystemPromptProvider]),
    Layer.succeed(ToolCatalogs, [setup.catalog]),
  );
  return Effect.gen(function* () {
    const session = yield* openSession;
    yield* session.observe(
      yield* opening(SessionId.make(setup.session ?? "fizzbuzz"), {
        provider: ProviderName.make("scripted"),
        model: ModelName.make("fizzbuzz-1"),
      }),
    );
    yield* Effect.forEach(
      inputs,
      (text) => session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: InputText.make(text) }),
      { discard: true },
    );
    return { facts: yield* session.facts, seen: model.seen };
  }).pipe(Effect.provide(services));
};
