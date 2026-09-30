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
import type { Fact } from "../../agent-machine/fact.ts";
import type { ModelTarget } from "../../agent-machine/observation.ts";
import { InputText, ModelName, ProviderName, SessionId } from "../../agent-machine/names.ts";
import type { ModelClient, ModelContext, ToolRunner } from "../../agent-session/contracts.ts";
import { sentIn } from "../../agent-session/sent.ts";
import { openSession } from "../../agent-session/loop.ts";
import { ModelFromFacts } from "../../agent-session/model-choice.ts";
import { CountingTurns, NoTurnEndHooks } from "../../agent-session/turns.ts";
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
  /** The model the session asks, and the client that reaches it; the scripted model when not given. */
  readonly model?: { readonly target: ModelTarget; readonly client: Layer.Layer<ModelClient> };
}

export const basic: Setup = { catalog: FizzBuzzToolCatalog, conversation: WholeConversation };

export const advanced: Setup = { catalog: AdvancedFizzBuzzToolCatalog, conversation: WholeConversation };

export interface Played {
  readonly facts: ReadonlyArray<Fact>;
  /** What each request carried, as recorded with it. */
  readonly seen: ReadonlyArray<ModelContext>;
}

const scripted: ModelTarget = { provider: ProviderName.make("scripted"), model: ModelName.make("fizzbuzz-1") };

export const play = (inputs: ReadonlyArray<string>, setup: Setup = basic): Effect.Effect<Played> => {
  const services = Layer.mergeAll(
    ModelFromFacts,
    setup.model?.client ?? scriptedFizzBuzzModel().layer,
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
      yield* opening(SessionId.make(setup.session ?? "fizzbuzz"), setup.model?.target ?? scripted),
    );
    yield* session.idle;
    yield* Effect.forEach(
      inputs,
      // Each input waits for the turn before it, so every input starts a turn of its own.
      (text) =>
        session
          .observe({ _tag: "InputArrived", from: { _tag: "User" }, text: InputText.make(text) })
          .pipe(Effect.andThen(session.idle)),
      { discard: true },
    );
    const facts = yield* session.facts;
    const seen = facts.flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "ModelRequestDispatched" ? [sentIn(fact.observation.sent)] : [],
    );
    return { facts, seen };
  }).pipe(Effect.provide(services), Effect.scoped);
};
