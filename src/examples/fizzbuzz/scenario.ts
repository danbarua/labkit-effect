/**
 * Plays a FizzBuzz conversation through the loop: the session opens asking the scripted model, with
 * the FizzBuzz system prompt and the setup's tools recorded; each input the user sends is
 * observed, and the loop carries out everything that follows. The result is the session's facts and
 * every context the model was sent.
 */

import { Effect, Layer } from "effect";
import {
  type Conversation,
  Notices,
  opening,
  SystemPrompts,
} from "../../agent-context/assemble.ts";
import { AgentContextAssembler, WholeConversation } from "../../agent-context/assembler.ts";
import { type CompactionPolicy, compactIfDue, Summaries, SummariesInMemory } from "../../agent-context/compaction.ts";
import type { WindowSummary } from "../../agent-context/forks.ts";
import type { Fact } from "../../agent-machine/fact.ts";
import type { ModelTarget } from "../../agent-machine/observation.ts";
import { InputText, ModelName, ProviderName, SessionId } from "../../agent-machine/names.ts";
import type { ModelClient, ModelContext, ToolRunner } from "../../agent-session/contracts.ts";
import { sentIn } from "../../agent-session/sent.ts";
import { openSession } from "../../agent-session/loop.ts";
import { makeSessionContext } from "../../agent-host/session-context.ts";
import { SessionContext } from "../../agent-environment/session-context.ts";
import { EphemeralSessionStore } from "../../agent-session/session-store.ts";
import { ModelFromFacts } from "../../agent-session/configuration/model-choice.ts";
import { CountingTurns } from "../../agent-session/turns.ts";
import { scriptedFizzBuzzModel } from "./model.ts";
import { FizzBuzzSystemPromptProvider } from "./prompt.ts";
import { AdvancedFizzBuzzTools, FizzBuzzTools } from "./tools.ts";
import { SourcedToolRunner, type ToolSource, ToolSources } from "../../agent-session/tool-sources.ts";

/** A user who counts: `count` messages, each the number after the one the model should have returned. */
export const countingUser = (count: number): ReadonlyArray<string> =>
  Array.from({ length: count }, (_, index) => String(2 * index + 1));

export interface Setup {
  readonly source: ToolSource;
  /** How the conversation is viewed for each request. */
  readonly conversation: Layer.Layer<Conversation, never, Summaries>;
  /** Runs the tools; the runner of the setup's source when not given. */
  readonly tools?: Layer.Layer<ToolRunner>;
  /** The session's id; "fizzbuzz" when not given. */
  readonly session?: string;
  /** The model the session asks, and the client that reaches it; the scripted model when not given. */
  readonly model?: { readonly target: ModelTarget; readonly client: Layer.Layer<ModelClient> };
  /** Asked after every turn whether to compact, and with which summarizer; never, when not given. */
  readonly compaction?: CompactionPolicy;
  /**
   * Changes of model the user makes: after the turn in which the count reaches a key (and after any
   * compaction then), the session is told to ask that key's model from then on.
   */
  readonly switches?: ReadonlyMap<number, ModelTarget>;
  /** Where the summaries are kept; in memory, for the one play, when not given. */
  readonly summaries?: Layer.Layer<Summaries>;
}

export const basic: Setup = { source: FizzBuzzTools, conversation: WholeConversation };

export const advanced: Setup = { source: AdvancedFizzBuzzTools, conversation: WholeConversation };

export interface Played {
  readonly facts: ReadonlyArray<Fact>;
  /** What each request carried, as recorded with it. */
  readonly seen: ReadonlyArray<ModelContext>;
  /** The summaries the compactions wrote, in order. */
  readonly summaries: ReadonlyArray<WindowSummary>;
}

const scripted: ModelTarget = { provider: ProviderName.make("scripted"), model: ModelName.make("fizzbuzz-1") };

export const play = (inputs: ReadonlyArray<string>, setup: Setup = basic): Effect.Effect<Played> =>
  Effect.gen(function* () {
    const summaries = yield* Summaries.pipe(Effect.provide(setup.summaries ?? SummariesInMemory));
    return yield* played(inputs, setup, summaries);
  });

const played = (inputs: ReadonlyArray<string>, setup: Setup, summaries: Summaries["Service"]): Effect.Effect<Played> => {
  const services = Layer.mergeAll(
    ModelFromFacts,
    setup.model?.client ?? scriptedFizzBuzzModel().layer,
    AgentContextAssembler.pipe(
      Layer.provide(
        Layer.mergeAll(setup.conversation.pipe(Layer.provide(Layer.succeed(Summaries, summaries))), Layer.succeed(Notices, [])),
      ),
    ),
    Layer.succeed(Summaries, summaries),
    CountingTurns,
    setup.tools ?? SourcedToolRunner,
    Layer.succeed(SystemPrompts, [FizzBuzzSystemPromptProvider]),
  ).pipe(Layer.provideMerge(Layer.succeed(ToolSources, [setup.source])));
  const id = SessionId.make(setup.session ?? "fizzbuzz");
  return Effect.gen(function* () {
    // The game has no working folder of its own: the session works in this process's, which its spans and log lines do not name.
    const made = yield* makeSessionContext({ session: id, working: process.cwd(), given: [] });
    return yield* Effect.provideService(SessionContext, made.context)(
      Effect.gen(function* () {
        const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
        yield* made.storeOpened(session.facts);
        const compaction = setup.compaction;
        const compactAfter = compaction === undefined ? Effect.void : compactIfDue(session, compaction).pipe(Effect.andThen(session.idle));
        const switchAfter = (text: string) => {
          const target = setup.switches?.get(Number(text) + 1);
          return target === undefined
            ? Effect.void
            : session.observe({ _tag: "ModelChangeArrived", ...target }).pipe(Effect.andThen(session.idle));
        };
        yield* session.observe(
          yield* opening(id, setup.model?.target ?? scripted),
        );
        yield* session.idle;
        yield* Effect.forEach(
          inputs,
          // Each input waits for the turn before it, so every input starts a turn of its own.
          (text) =>
            session
              .observe({ _tag: "InputArrived", from: { _tag: "User" }, text: InputText.make(text) })
              .pipe(Effect.andThen(session.idle), Effect.andThen(compactAfter), Effect.andThen(switchAfter(text))),
          { discard: true },
        );
        const facts = yield* session.facts;
        const seen = facts.flatMap((fact) =>
          fact._tag === "Observed" && fact.observation._tag === "ModelRequestDispatched" ? [sentIn(fact.observation.sent)] : [],
        );
        return { facts, seen, summaries: yield* summaries.recorded };
      }),
    );
    // The facts are kept in memory, where writing them down does not fail.
  }).pipe(Effect.provide(services), Effect.scoped, Effect.orDie);
};
