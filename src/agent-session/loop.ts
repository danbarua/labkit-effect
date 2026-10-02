/**
 * The loop around the core: it records each observation, asks the core what follows, records the
 * decisions, and carries out the requests, each of whose outcome is the next observation.
 *
 * The session's facts are kept in its store (`SessionStore`), which the loop needs to run. Each fact
 * is written down before anything is done on it: an observation before the core decides on it, the
 * decisions before the requests that follow from them are carried out. A write that fails stops the
 * session: nothing after it is written or done, the requests under way are stopped, and `observe`
 * and `idle` fail with it.
 *
 * Observations are recorded one at a time, in the order they arrive. Each request is carried out
 * in a fiber of its own, so the session takes further observations meanwhile: input is queued in
 * the core's mailboxes. When the core asks for a turn's work to stop (it was interrupted), each
 * request under way ends what it is doing and reports how far it got: a model request, the response
 * as far as it had arrived; a tool run, that how it ended was not observed. That a request was made
 * is recorded before it goes out: `ModelRequestDispatched`, `ToolCallDispatched`. `idle` waits until no request is being carried out. The session lives in a scope;
 * closing it ends whatever is still being carried out.
 *
 * When a turn starts is decided here: when input arrives and the agent is idle, the loop starts a
 * turn through `Turns` and reports `TurnStarted`.
 *
 * While a request is carried out, `CurrentWork` says what it is about (the session, its turn, and
 * for a tool run its call and tool), and every log line written is annotated with the same, so the
 * services it calls do not pass those along themselves. Each request is carried out in a span named
 * for its kind (`agent.model.request`, `agent.tool.run`, `agent.turn.review`), with the same as its
 * attributes; the observations that follow are recorded outside it. The session is a span
 * (`agent.session`) from when it is opened until its scope closes, and each turn a span under it
 * (`agent.turn`) from `TurnStarted` until `TurnEnded`, or until the scope closes. A request's span
 * is under its turn's, or the session's when its turn has no span (a turn started before a resume).
 * What happens during a request besides its outcome (a failed attempt at it, say) is recorded at
 * once through `Report`.
 *
 * Each fact is logged as it is recorded (`loop.observation.recorded`, `loop.decision.recorded`), so a
 * session's log follows everything that happens to it. Each fact is published as it is recorded;
 * `subscribe` receives every fact recorded after it.
 * What a model request streams is passed on to `streamed` and not recorded.
 *
 * A host drives turns through `prompt`, `cancel` and `turn`, or gives observations through
 * `observe` and waits with `idle`. `prompt` records the user's input and waits for the end of the
 * turn that took it, by the facts recorded, not by `idle`: `idle` also waits for a tool call's
 * permission question, which a host answers from another fiber while `prompt` waits.
 */

import { keptOutcome } from "./blobs.ts";
import { Clock, DateTime, Deferred, Effect, Exit, FiberSet, PubSub, Ref, type Scope, Semaphore, type Tracer } from "effect";
import type { Decision, Ending } from "../agent-machine/decision.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { notObserved } from "../agent-machine/not-observed.ts";
import { deliver, type World } from "../agent-machine/router.ts";
import { leftRunning, worldAndRequestsOf } from "../agent-machine/left-running.ts";
import { FailureText, InputText, Millis, type ModelName, ModelText, type ProviderName, Seq, type SessionId, ThinkingText, type TurnId } from "../agent-machine/names.ts";
import type { CapturedObservation, ModelPart, Observation, ToolOutcome } from "../agent-machine/observation.ts";
import type { Origin } from "../agent-machine/origin.ts";
import type { EffectRequest } from "../agent-machine/request.ts";
import { emptyHeld, type Held as Throttled, throttle, type ThrottleInput } from "../agent-machine/throttle.ts";
import { ContextAssembler, ModelClient, ModelProvider, ToolCallPolicy, ToolRunner, TurnEndHooks, Turns } from "./contracts.ts";
import type { Verdict } from "../agent-policy/policy.ts";
import type { Received } from "../agent-machine/received.ts";
import { logKeys } from "./log-keys.ts";
import { asText, receivedJson, receivedText } from "./received.ts";
import { ModelStream, ModelStreamInterval, type Streamed } from "./model-stream.ts";
import { CurrentOrigin, harnessParts, reportedBy } from "./origin.ts";
import { Report } from "./report.ts";
import { sentAs } from "./sent.ts";
import { immutableToolCatalogOf, modelOf } from "./configuration/session-setup.ts";
import { SessionStore, type SessionStoreFailed } from "./session-store.ts";
import { CurrentWork, type Work } from "./work.ts";

/**
 * The core's machines as `facts` leave them. Between turns they hold nothing: no turn runs, and the
 * machines of a turn that has ended are finished. So only what was recorded after the last turn
 * ended bears on them: input waiting for a turn, or a turn the facts leave running. Those
 * observations are delivered in order, and the machines' state is what is kept.
 */
/** The machines as `facts` leave them. */
const worldOf = (facts: ReadonlyArray<Fact>): World => worldAndRequestsOf(facts).world;

/**
 * An observation in brief, for the log: each of its fields that is text (its first 200 characters),
 * a number or a flag, and the kind of each that has one (an outcome, an ending). What it carries
 * besides (a response's parts, what a request sent) is in the facts.
 */
const inBrief = (observation: Observation): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(observation).flatMap(([field, value]): ReadonlyArray<readonly [string, unknown]> => {
      if (field === "_tag") return [];
      if (typeof value === "string") return [[field, value.length > 200 ? `${value.slice(0, 200)}…` : value]];
      if (typeof value === "number" || typeof value === "boolean") return [[field, value]];
      if (typeof value === "object" && value !== null && "_tag" in value) return [[field, value._tag]];
      return [];
    }),
  );

/** A delta as `streamed` gives it: its text branded for the kind of part it is added to. */
const deltaOf = (turn: TurnId, kind: "Text" | "Commentary" | "Thinking", text: string): CapturedObservation =>
  kind === "Thinking" ? { _tag: "ModelDelta", turn, kind, text: ThinkingText.make(text) } : { _tag: "ModelDelta", turn, kind, text: ModelText.make(text) };

/** The session the facts opened, if they have. */
const sessionOf = (facts: ReadonlyArray<Fact>): SessionId | undefined =>
  facts.flatMap((fact) =>
    fact._tag === "Observed" && fact.observation._tag === "SessionOpened" ? [fact.observation.session] : [],
  )[0];

/** The turn under way: the latest one started, while no `TurnEnded` is recorded for it. */
const turnUnderWay = (facts: ReadonlyArray<Fact>): TurnId | undefined =>
  facts.reduce<TurnId | undefined>((turn, fact) => {
    if (fact._tag === "Observed" && fact.observation._tag === "TurnStarted") return fact.observation.turn;
    if (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" && fact.decision.turn === turn) return undefined;
    return turn;
  }, undefined);

/** The span each kind of request is carried out in. */
const spanNames: Record<EffectRequest["_tag"], string> = {
  RequestModelResponse: "agent.model.request",
  RunTool: "agent.tool.run",
  BeforeTurnEnded: "agent.turn.review",
  StopTurnWork: "agent.turn.stop",
};

/** An observation, and who or what it came from. */
interface Observed {
  readonly origin: Origin;
  readonly observation: Observation;
}

/** A request the core made, and what it is about. */
interface Started {
  readonly request: EffectRequest;
  readonly work: Work;
}

/**
 * How many times the turn-end hooks have held `turn` open: the reviews of it in which they gave
 * feedback. Each is on record as the feedback, given as input by the hooks, and the review after it.
 */
const holdsOf = (facts: ReadonlyArray<Fact>, turn: TurnId): number =>
  facts.reduce(
    (state, fact) => {
      if (fact._tag !== "Observed") return state;
      const fromHooks = fact.origin._tag === "Harness" && fact.origin.part === harnessParts.turnEndHooks.part;
      if (fact.observation._tag === "InputArrived" && fromHooks) return { ...state, feedback: true };
      if (fact.observation._tag !== "TurnEndReviewed" || fact.observation.turn !== turn) return state;
      return { holds: state.feedback ? state.holds + 1 : state.holds, feedback: false };
    },
    { holds: 0, feedback: false },
  ).holds;

/** What the loop needs to carry out requests. */
export type Services = ModelProvider | ContextAssembler | ModelClient | Turns | ToolRunner | TurnEndHooks;

/** What the user gives a turn: the text, and the files that came with it. */
export type Prompt = Pick<Extract<Observation, { _tag: "InputArrived" }>, "text" | "attachments">;

export interface Session {
  /**
   * Records an observation, with the origin `CurrentOrigin` gives, and starts what follows from it.
   * It returns once the observation is recorded; the requests that follow are carried out after.
   */
  readonly observe: (observation: Observation) => Effect.Effect<void, SessionStoreFailed, Services>;
  /**
   * The turn under way, if one is: the latest `TurnStarted` with no `TurnEnded` recorded for it. A
   * turn the facts left running (`leftRunning`) is under way until the host goes on with it or
   * ends it.
   */
  readonly turn: Effect.Effect<TurnId | undefined>;
  /**
   * Records `input` as the user's (`InputArrived`, with the origin `CurrentOrigin` gives) and
   * returns how the turn that took it ended. With no turn under way the loop starts one for it.
   * With one under way the input goes to that turn, which takes it between steps (agent-machine I3);
   * if that turn ends other than by an answer the input is dropped (I6), and `prompt` returns that
   * ending all the same. Two at once are recorded one after the other, and both go to the same turn
   * unless it ends between them. It fails if writing the session's facts fails, then or while it
   * waits.
   */
  readonly prompt: (input: Prompt) => Effect.Effect<Ending, SessionStoreFailed, Services>;
  /**
   * Records `TurnInterrupted` for the turn under way, with the origin `CurrentOrigin` gives, and
   * returns once it is recorded; the turn ends `Interrupted` once its requests have reported how
   * far they got (agent-machine X1–X3). With no turn under way it records nothing.
   */
  readonly cancel: Effect.Effect<void, SessionStoreFailed, Services>;
  /** Waits until no request is being carried out; fails if writing the session's facts failed. */
  readonly idle: Effect.Effect<void, SessionStoreFailed>;
  /** The session's facts, as its store keeps them. */
  readonly facts: Effect.Effect<ReadonlyArray<Fact>>;
  /**
   * Goes on with the turn the facts left running, when the session went on from facts that stop
   * while a turn runs (`leftRunning`): each request they left with no outcome is carried out. A
   * model request is made (again). A tool call runs (again) only when its tool's `replay` is `safe`:
   * it changes nothing. Any other call is not run: it ends `Indeterminate` if it had begun, and
   * `NotRun` if not. What it would change may have changed since it was asked for, and the model
   * looks before it asks for it again. A turn that was being stopped is given what is
   * known of each request, and ends. Input that arrived with no turn started for it starts one.
   * The other choice is `endTurnLeftRunning`; which to make is the host's.
   */
  readonly goOn: Effect.Effect<void, SessionStoreFailed, Services>;
  /** Every fact recorded from now on, in order, for as long as the scope lasts. */
  readonly subscribe: Effect.Effect<PubSub.Subscription<Fact>, never, Scope.Scope>;
  /**
   * What model requests pass on while their responses stream, from now on and for as long as the
   * scope lasts: stream events, held and released in batches, and each part as it is completed.
   * None of it is recorded.
   */
  readonly streamed: Effect.Effect<PubSub.Subscription<CapturedObservation>, never, Scope.Scope>;
}

/**
 * A session over the facts its store keeps: a new one, or one that goes on from them (another
 * session's, or this one's before its process ended). Between turns that is all there is to going
 * on, because going on from facts that stop between turns is no different from starting the next
 * turn. Everything a turn's requests carry (the conversation, the model and its settings, the
 * system prompt, the tools) is read from the facts when the request is made. The machines start as
 * the facts leave them (`worldOf`). Facts that stop while a turn runs leave it running, with its
 * requests under way and no one carrying them out: the host goes on with it (`goOn`) or ends it
 * (`endTurnLeftRunning`).
 *
 * The turns that start from here need identities the facts have not used: that is `Turns`' business.
 */
export const openSession: Effect.Effect<Session, never, Scope.Scope | SessionStore> = Effect.gen(function* () {
  const store = yield* SessionStore;
  const facts = yield* store.facts;
  // Made before `running`, so closing the scope ends the requests' spans, then the turns', then this.
  const sessionSpan = yield* Effect.makeSpanScoped("agent.session");
  // A turn's span stays here after it ends: requests that follow from its ending are still under it.
  const turnSpans = yield* Ref.make<ReadonlyMap<TurnId, Tracer.Span>>(new Map());
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeNanos;
      const open = [...(yield* Ref.get(turnSpans)).values()].filter((span) => span.status._tag === "Started");
      yield* Effect.forEach(open, (span) => Effect.sync(() => span.end(now, Exit.void)), { discard: true });
    }),
  );
  /** Names the session on its span when it opens, opens a turn's span when it starts, and ends it when it ends. */
  const traceTurns = (observation: Observation, decisions: ReadonlyArray<Decision>, session: SessionId | undefined) =>
    Effect.gen(function* () {
      if (observation._tag === "SessionOpened") sessionSpan.attribute("session", observation.session);
      if (observation._tag === "TurnStarted") {
        const span = yield* Effect.makeSpan("agent.turn", {
          parent: sessionSpan,
          attributes: { ...(session === undefined ? {} : { session }), turn: observation.turn },
        });
        yield* Ref.update(turnSpans, (now) => new Map([...now, [observation.turn, span]]));
      }
      const spans = yield* Ref.get(turnSpans);
      const now = yield* Clock.currentTimeNanos;
      const ended = decisions.flatMap((decision) => (decision._tag === "TurnEnded" ? [decision] : []));
      yield* Effect.forEach(
        ended,
        (decision) =>
          Effect.sync(() => {
            const span = spans.get(decision.turn);
            span?.attribute("ending", decision.ending._tag);
            span?.end(now, Exit.void);
          }),
        { discard: true },
      );
    });
  const machines = yield* Ref.make<World>(worldOf(facts));
  const recorded = yield* PubSub.unbounded<Fact>();
  const captured = yield* PubSub.unbounded<CapturedObservation>();
  const lock = yield* Semaphore.make(1);
  const running = yield* FiberSet.make<void, never>();
  const broken = yield* Deferred.make<never, SessionStoreFailed>();

  /**
   * Writes `facts` down. After a write that failed nothing more is written: the session stops, and
   * the requests under way are stopped.
   */
  const written = (more: ReadonlyArray<Fact>): Effect.Effect<void, SessionStoreFailed> =>
    Effect.gen(function* () {
      if (yield* Deferred.isDone(broken)) return yield* Deferred.await(broken);
      yield* store.append(more).pipe(
        Effect.tapError((error) =>
          Deferred.fail(broken, error).pipe(
            Effect.andThen(Effect.logError(logKeys.loop.storeFailed, { message: error.message, facts: more.map((fact) => fact.seq) })),
            Effect.andThen(Effect.forkDetach(FiberSet.clear(running))),
          ),
        ),
      );
    });
  const cancels = yield* Ref.make<ReadonlyMap<TurnId, Deferred.Deferred<void>>>(new Map());

  /**
   * The turn-end hooks' feedback as input, then the review. Once they have held the turn `maxHolds`
   * times, feedback they still give is not given to it: it is recorded (`TurnHoldsExhausted`) and
   * logged, then the review. Hooks with nothing more let it end either way.
   */
  const reviewTurnEnd = (turn: TurnId): Effect.Effect<ReadonlyArray<Observed>, never, Services> =>
    Effect.gen(function* () {
      const { hooks, maxHolds } = yield* TurnEndHooks;
      const holds = holdsOf(yield* store.facts, turn);
      const origin = harnessParts.turnEndHooks;
      const reviewed: Observed = { origin, observation: { _tag: "TurnEndReviewed", turn } };
      const feedback = (yield* Effect.forEach(hooks, (hook) => hook(turn))).flat();
      if (feedback.length === 0) return [reviewed];
      if (holds >= maxHolds) {
        yield* Effect.logWarning(logKeys.loop.holdsExhausted, { holds, maxHolds, feedback });
        return [{ origin, observation: { _tag: "TurnHoldsExhausted", turn, holds, feedback: feedback.map((text) => InputText.make(text)) } }, reviewed];
      }
      yield* Effect.logInfo(logKeys.loop.turnHeld, { hold: holds + 1, maxHolds, feedback: feedback.length });
      const inputs = feedback.map(
        (text): Observed => ({
          origin,
          observation: { _tag: "InputArrived", from: { _tag: "System" }, text: InputText.make(text) },
        }),
      );
      return [...inputs, reviewed];
    });

  /** The signal that ends what `turn`'s requests are doing in the world, made when first asked for. */
  const cancelOf = (turn: TurnId): Effect.Effect<Deferred.Deferred<void>> =>
    Ref.modify(cancels, (now) => {
      const made = now.get(turn) ?? Deferred.makeUnsafe<void>();
      return [made, now.has(turn) ? now : new Map([...now, [turn, made]])];
    });

  /**
   * Carries out `request` with what it streams passed on to `streamed`: events and the text they add
   * to parts held and released in batches at most once per `ModelStreamInterval`; a completed part,
   * and the end of the request, release what is held. The end of the request is passed on last
   * (`ModelResponseEnded`), however it ended.
   */
  const passingOn = <A, R>(turn: TurnId, request: Effect.Effect<A, never, R>): Effect.Effect<A, never, R> =>
    Effect.gen(function* () {
      const interval = yield* ModelStreamInterval;
      const held = yield* Ref.make(emptyHeld<CapturedObservation>());
      const step = (inputs: (at: Millis) => ReadonlyArray<ThrottleInput<CapturedObservation>>) =>
        Effect.gen(function* () {
          const at = Millis.make(yield* Clock.currentTimeMillis);
          const batch = yield* Ref.modify(held, (now) =>
            inputs(at).reduce<readonly [ReadonlyArray<CapturedObservation>, Throttled<CapturedObservation>]>(
              ([released, state], input) => {
                const next = throttle(interval, state, input);
                return [[...released, ...next.batch], next.held];
              },
              [[], now],
            ),
          );
          yield* PubSub.publishAll(captured, batch);
        });
      const sink = (streamed: Streamed) => {
        switch (streamed._tag) {
          case "Chunk":
            return step((at) => [{ _tag: "Captured", item: { _tag: "ModelStreamed", turn, chunk: streamed.chunk }, at }]);
          case "Delta":
            // A delta with no text adds nothing to its part.
            return streamed.text === ""
              ? Effect.void
              : step((at) => [{ _tag: "Captured", item: deltaOf(turn, streamed.kind, streamed.text), at }]);
          case "Part":
            return step((at) => [
              { _tag: "Captured", item: { _tag: "ModelPartArrived", turn, part: streamed.part }, at },
              { _tag: "Ended", at },
            ]);
          default:
            return streamed satisfies never;
        }
      };
      return yield* request.pipe(
        Effect.provideService(ModelStream, sink),
        // However the request ends (answered, failed, stopped), its end is the last of what it streamed.
        Effect.ensuring(step((at) => [{ _tag: "Captured", item: { _tag: "ModelResponseEnded", turn }, at }, { _tag: "Ended", at }])),
      );
    });

  /**
   * What the log says of a tool call that ended: the call, the tool, its input, and how it ended,
   * with what it returned or why it failed. Content is given by its length and its first 300
   * characters.
   */
  const toolEndedDetails = (request: Extract<EffectRequest, { _tag: "RunTool" }>, outcome: ToolOutcome): Record<string, unknown> => {
    const shown = (received: Received) => {
      const text = asText(received);
      return { chars: text.length, start: text.slice(0, 300) };
    };
    const reason = outcome._tag === "Failed" ? outcome.reason : undefined;
    return {
      call: request.call,
      tool: request.tool,
      input: shown(request.input),
      outcome: outcome._tag,
      ...(outcome._tag === "Succeeded" ? { output: shown(outcome.output) } : {}),
      ...(reason === undefined ? {} : { reason: reason._tag }),
      ...(reason?._tag === "InputRejected" ? { problem: reason.problem } : {}),
      ...(reason?._tag === "Reported" ? { error: shown(reason.error) } : {}),
      ...(reason?._tag === "Vetoed" ? { vetoed: shown(reason.reason) } : {}),
    };
  };

  /**
   * The verdict of the tool call policy on a call, as the facts stand. While the policy waits, what
   * it asks is recorded (`PermissionAsked`), and the next answer observed for the call
   * (`PermissionAnswered`) is given to it. A policy that waits without asking is a defect: nothing
   * would answer it.
   */
  const reviewed = (request: Extract<EffectRequest, { _tag: "RunTool" }>): Effect.Effect<Verdict, never, Services> =>
    Effect.scoped(
      Effect.gen(function* () {
        const policy = yield* (yield* ToolCallPolicy)(yield* store.facts);
        const answers = yield* PubSub.subscribe(recorded);
        let step = policy.start(request);
        while (step._tag === "Waiting") {
          if (step.asks === undefined) return yield* Effect.die(new Error(`The tool call policy waited on ${request.call} without asking anything`));
          yield* (yield* Report)({ _tag: "PermissionAsked", call: request.call, asks: step.asks }, harnessParts.toolCallPolicy);
          let answer: Received | undefined;
          while (answer === undefined) {
            const fact = yield* PubSub.take(answers);
            if (fact._tag === "Observed" && fact.observation._tag === "PermissionAnswered" && fact.observation.call === request.call)
              answer = fact.observation.answer;
          }
          step = policy.receive(step.state, { _tag: "Answered", answer });
        }
        return step.verdict;
      }),
    );

  /**
   * Carries out one request in the world. `stop` is completed when the request's turn is to stop
   * its work: the request then ends what it is doing and reports how far it got.
   */
  const carryOut = (
    request: EffectRequest,
    stop: Deferred.Deferred<void> | undefined,
  ): Effect.Effect<ReadonlyArray<Observed>, never, Services> => {
    const stopped = stop === undefined ? Effect.never : Deferred.await(stop);
    switch (request._tag) {
      case "RequestModelResponse":
        return passingOn(
          request.turn,
          Effect.gen(function* () {
            const facts = yield* store.facts;
            const target = yield* (yield* ModelProvider).select(facts, request.turn);
            const context = yield* (yield* ContextAssembler).assemble(facts, request.turn);
            const asked: Origin = { _tag: "Provider", provider: target.provider };
            const report = yield* Report;
            const passOn = yield* ModelStream;
            const arrived = yield* Ref.make<ReadonlyArray<ModelPart>>([]);
            // A tool call that is complete is recorded, so the core runs it without waiting for the
            // rest of the response; every completed part is kept, for a response stopped early.
            const sink = (streamed: Streamed) =>
              Effect.gen(function* () {
                if (streamed._tag === "Part") {
                  const part = streamed.part;
                  if (part._tag === "ToolCall")
                    yield* report(
                      { _tag: "ToolCallArrived", turn: request.turn, call: part.call, tool: part.tool, input: part.input },
                      asked,
                    );
                  yield* Ref.update(arrived, (parts) => [...parts, part]);
                }
                yield* passOn(streamed);
              });
            const asFarAsArrived = stopped.pipe(
              Effect.andThen(Ref.get(arrived)),
              Effect.map(
                (parts): Extract<Observation, { _tag: "ModelResponded" }> => ({
                  _tag: "ModelResponded",
                  turn: request.turn,
                  provider: target.provider,
                  model: target.model,
                  parts,
                  ending: { _tag: "Interrupted" },
                  metadata: receivedJson({}),
                }),
              ),
            );
            yield* report(
              {
                _tag: "ModelRequestDispatched",
                turn: request.turn,
                provider: target.provider,
                model: target.model,
                sent: sentAs(context),
              },
              harnessParts.loop,
            );
            const outcome = yield* (yield* ModelClient)
              .respond(target, context, request.turn)
              .pipe(Effect.provideService(ModelStream, sink), Effect.raceFirst(asFarAsArrived));
            // A response names the provider that gave it, which a fallback makes another than the one asked.
            const provider = outcome._tag === "ModelResponded" ? outcome.provider : target.provider;
            return [{ origin: { _tag: "Provider", provider }, observation: outcome } satisfies Observed];
          }),
        );
      case "RunTool": {
        const origin: Origin = { _tag: "Tool", tool: request.tool };
        const ended = (outcome: ToolOutcome): ReadonlyArray<Observed> => [
          { origin, observation: { _tag: "ToolEnded", call: request.call, outcome } },
        ];
        const notRun = ended({ _tag: "Failed", reason: { _tag: "NotRun" } });
        const vetoed = (reason: Received): ReadonlyArray<Observed> => [
          { origin: harnessParts.toolCallPolicy, observation: { _tag: "ToolEnded", call: request.call, outcome: { _tag: "Failed", reason: { _tag: "Vetoed", reason } } } },
        ];
        return Effect.gen(function* () {
          if (stop !== undefined && (yield* Deferred.isDone(stop))) return notRun;
          const verdict = yield* reviewed(request).pipe(Effect.raceFirst(stopped.pipe(Effect.as("stopped" as const))));
          if (verdict === "stopped") return notRun;
          if (verdict._tag === "Veto") return vetoed(verdict.reason);
          yield* (yield* Report)({ _tag: "ToolCallDispatched", call: request.call }, harnessParts.toolRunner);
          const outcome = yield* (yield* ToolRunner)
            .run(request.tool, request.input, request.call)
            .pipe(Effect.raceFirst(stopped.pipe(Effect.as<ToolOutcome>({ _tag: "Failed", reason: { _tag: "Indeterminate" } }))));
          return ended(yield* keptOutcome(outcome));
        }).pipe(
          Effect.tap((observed) =>
            Effect.forEach(
              observed,
              ({ observation }) => (observation._tag === "ToolEnded" ? Effect.logInfo(logKeys.loop.toolEnded, toolEndedDetails(request, observation.outcome)) : Effect.void),
              { discard: true },
            ),
          ),
        );
      }
      case "BeforeTurnEnded":
        return reviewTurnEnd(request.turn).pipe(Effect.raceFirst(stopped.pipe(Effect.as<ReadonlyArray<Observed>>([]))));
      case "StopTurnWork":
        return cancelOf(request.turn).pipe(
          Effect.flatMap((cancel) => Deferred.succeed(cancel, undefined)),
          Effect.as([]),
        );
      default:
        return request satisfies never;
    }
  };

  /** What a request is about: the session the facts opened, and the request's turn, call and tool. */
  const about = (request: EffectRequest, world: World, facts: ReadonlyArray<Fact>): Work => {
    const opened = sessionOf(facts);
    const session = opened === undefined ? {} : { session: opened };
    const turn = world.agent.state._tag === "Running" ? { turn: world.agent.state.turn } : {};
    switch (request._tag) {
      case "RequestModelResponse":
        return { ...session, turn: request.turn };
      case "RunTool":
        return { ...session, ...turn, call: request.call, tool: request.tool };
      case "BeforeTurnEnded":
      case "StopTurnWork":
        return { ...session, turn: request.turn };
      default:
        return request satisfies never;
    }
  };

  /**
   * Records the observation and the decisions that follow from it, and returns the requests that
   * follow, each with what it is about. One observation is recorded at a time: callers hold `lock`.
   */
  const write = (origin: Origin, observation: Observation): Effect.Effect<ReadonlyArray<Started>, SessionStoreFailed, Services> =>
    Effect.gen(function* () {
      const before = yield* store.facts;
      const seq = Seq.make(before.length + 1);
      const time = yield* DateTime.now;
      const observed: Fact = { _tag: "Observed", seq, time, origin, observation };
      // The observation is written down before the core decides on it, and the decisions before
      // anything follows from them.
      yield* written([observed]);
      const outcome = deliver(yield* Ref.get(machines), seq, observation);
      const decided = outcome.decisions.map(
        (decision, index): Fact => ({ _tag: "Decided", seq: Seq.make(seq + 1 + index), time, decision }),
      );
      yield* written(decided);
      yield* Ref.set(machines, outcome.world);
      const facts = [observed, ...decided];
      const now = [...before, ...facts];
      yield* PubSub.publishAll(recorded, facts);
      const session = sessionOf(now);
      yield* traceTurns(observation, outcome.decisions, session);
      yield* Effect.logInfo(logKeys.loop.observationRecorded, { observation: observation._tag, seq, origin, details: inBrief(observation) }).pipe(
        Effect.annotateLogs(session === undefined ? {} : { session }),
      );
      yield* Effect.forEach(decided, (fact) =>
        fact._tag === "Decided"
          ? Effect.logInfo(logKeys.loop.decisionRecorded, {
              decision: fact.decision._tag,
              seq: fact.seq,
              after: seq,
              details: fact.decision,
            }).pipe(Effect.annotateLogs(session === undefined ? {} : { session }))
          : Effect.void,
      );
      const started = outcome.requests.map((request) => ({ request, work: about(request, outcome.world, now) }));
      if (observation._tag !== "InputArrived" || outcome.world.agent.state._tag !== "Idle") return started;
      const turn = yield* (yield* Turns).start;
      return [...started, ...(yield* write(harnessParts.loop, { _tag: "TurnStarted", turn }))];
    });

  /** Carries out one request in the world and records each observation that comes of it. */
  const carry = ({ request, work }: Started): Effect.Effect<void, never, Services> =>
    Effect.gen(function* () {
      const services = yield* Effect.context<Services>();
      // A report that cannot be written down stops the request: it does not go on to do what it reported.
      const report = (reported: Observation, by: Origin) =>
        record(by, reported).pipe(Effect.provideContext(services), Effect.catchTag("SessionStoreFailed", () => Effect.interrupt));
      const stop = work.turn === undefined ? undefined : yield* cancelOf(work.turn);
      // Given, not inherited: this fiber was started from whichever fiber recorded the observation.
      const parent = (work.turn === undefined ? undefined : (yield* Ref.get(turnSpans)).get(work.turn)) ?? sessionSpan;
      const observed = yield* carryOut(request, stop).pipe(
        Effect.withSpan(spanNames[request._tag], { attributes: { ...work } }),
        Effect.withParentSpan(parent),
        Effect.annotateLogs({ ...work }),
        Effect.provideService(CurrentWork, work),
        Effect.provideService(Report, report),
      );
      yield* Effect.forEach(observed, (each) => record(each.origin, each.observation), { discard: true });
    }).pipe(
      // A request that dies (a defect: a provider with no client configured, say) is logged with what
      // it died of, and an outcome is recorded for it, so that its turn goes on to its end and whoever
      // runs the session gets it back: a model request failed, a tool's end was not observed, a
      // turn-end review gave nothing more.
      Effect.catchDefect((defect) => {
        const died = defect instanceof Error ? (defect.stack ?? defect.message) : String(defect);
        const outcome = ((): Observation | undefined => {
          switch (request._tag) {
            case "RequestModelResponse":
              return {
                _tag: "ModelFailed",
                turn: request.turn,
                failure: FailureText.make(`The request died: ${defect instanceof Error ? defect.message : String(defect)}`),
                error: receivedText(died),
              };
            case "RunTool":
              return { _tag: "ToolEnded", call: request.call, outcome: { _tag: "Failed", reason: { _tag: "Indeterminate" } } };
            case "BeforeTurnEnded":
              return { _tag: "TurnEndReviewed", turn: request.turn };
            case "StopTurnWork":
              return undefined;
            default:
              return request satisfies never;
          }
        })();
        return Effect.logError(logKeys.loop.requestDied, { request: request._tag, ...work, defect: died }).pipe(
          Effect.andThen(outcome === undefined ? Effect.void : record(harnessParts.loop, outcome)),
        );
      }),
      // A write that failed is logged where it failed, and the session has stopped.
      Effect.catchTag("SessionStoreFailed", () => Effect.void),
    );

  /**
   * Runs `step`, which records observations, holding `lock`; then starts each request it returns in
   * a fiber of its own, and gives what else it returns.
   */
  const recording = <A>(
    step: Effect.Effect<readonly [ReadonlyArray<Started>, A], SessionStoreFailed, Services>,
  ): Effect.Effect<A, SessionStoreFailed, Services> =>
    step.pipe(
      Semaphore.withPermit(lock),
      Effect.flatMap(([started, result]) =>
        Effect.forEach(started, (each) => FiberSet.run(running, carry(each)), { discard: true }).pipe(Effect.as(result)),
      ),
      Effect.uninterruptible,
    );

  /** Records the observation, then starts each request that follows in a fiber of its own. */
  const record = (origin: Origin, observation: Observation): Effect.Effect<void, SessionStoreFailed, Services> =>
    recording(write(origin, observation).pipe(Effect.map((started) => [started, undefined] as const)));

  /** The origin `CurrentOrigin` gives what is observed now. A session given an observation with none set is a defect. */
  const originFor = (what: Observation["_tag"]): Effect.Effect<Origin> =>
    Effect.gen(function* () {
      const origin = yield* CurrentOrigin;
      if (origin === undefined) return yield* Effect.die(new Error(`${what} was given to a session with no origin set`));
      return origin;
    });

  const observe = (observation: Observation): Effect.Effect<void, SessionStoreFailed, Services> =>
    originFor(observation._tag).pipe(Effect.flatMap((origin) => record(origin, observation)));

  const prompt = (input: Prompt): Effect.Effect<Ending, SessionStoreFailed, Services> =>
    Effect.scoped(
      Effect.gen(function* () {
        const origin = yield* originFor("InputArrived");
        // Subscribed before the input is recorded, so the end of its turn cannot be missed.
        const fromNow = yield* PubSub.subscribe(recorded);
        // The input is built from `input`'s fields alone: whatever else the caller's value carries is not recorded.
        const arrived: Observation = {
          _tag: "InputArrived",
          from: { _tag: "User" },
          text: input.text,
          ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
        };
        // The turn the input went to, read while the lock is held: the one under way, or the one
        // started for it. Input in a turn's mailbox is taken by that turn or dropped when it ends.
        const turn = yield* recording(
          Effect.gen(function* () {
            const started = yield* write(origin, arrived);
            const agent = (yield* Ref.get(machines)).agent.state;
            return [started, agent._tag === "Running" ? agent.turn : undefined] as const;
          }),
        );
        if (turn === undefined) return yield* Effect.die(new Error("No turn was under way or started for the input given to prompt"));
        const ended = Effect.gen(function* () {
          let ending: Ending | undefined;
          while (ending === undefined) {
            const fact = yield* PubSub.take(fromNow);
            if (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" && fact.decision.turn === turn) ending = fact.decision.ending;
          }
          return ending;
        });
        // A write that fails stops the session, and the turn's end is never recorded.
        return yield* ended.pipe(Effect.raceFirst(Deferred.await(broken)));
      }),
    );

  const cancel: Effect.Effect<void, SessionStoreFailed, Services> = Effect.gen(function* () {
    const origin = yield* originFor("TurnInterrupted");
    // The turn is read while the lock is held, so it cannot end between being read and being interrupted.
    yield* recording(
      Effect.gen(function* () {
        const turn = turnUnderWay(yield* store.facts);
        const started: ReadonlyArray<Started> = turn === undefined ? [] : yield* write(origin, { _tag: "TurnInterrupted", turn });
        return [started, undefined] as const;
      }),
    );
  });

  const goOn: Effect.Effect<void, SessionStoreFailed, Services> = Effect.gen(function* () {
    const facts = yield* store.facts;
    const world = yield* Ref.get(machines);
    const left = leftRunning(facts);
    if (left === undefined) {
      const waiting = world.agent.state._tag === "Idle" && world.agent.mailbox.some((each) => each.message._tag === "InputArrived");
      if (waiting) yield* record(harnessParts.resume, { _tag: "TurnStarted", turn: yield* (yield* Turns).start });
      return;
    }
    if (left.stopping) {
      const outcomes = notObserved(world, left.turn, yield* askedIn(facts, left.turn), arrivedIn(facts, left.turn));
      yield* Effect.forEach(outcomes, (outcome) => record(harnessParts.resume, outcome), { discard: true });
      return;
    }
    const tools = yield* immutableToolCatalogOf(facts);
    yield* Effect.forEach(
      left.requests,
      (request) => {
        const replay = request._tag === "RunTool" ? (tools.find((tool) => tool.name === request.tool)?.replay ?? "unsafe") : undefined;
        if (request._tag === "RunTool" && replay !== "safe")
          return record(harnessParts.resume, {
            _tag: "ToolEnded",
            call: request.call,
            outcome: { _tag: "Failed", reason: { _tag: left.began.has(request.call) ? "Indeterminate" : "NotRun" } },
          });
        return FiberSet.run(running, carry({ request, work: about(request, world, facts) })).pipe(Effect.asVoid);
      },
      { discard: true },
    );
  });

  return {
    observe,
    turn: Effect.map(store.facts, turnUnderWay),
    prompt,
    cancel,
    idle: FiberSet.awaitEmpty(running).pipe(
      Effect.andThen(Deferred.isDone(broken)),
      Effect.flatMap((done) => (done ? Deferred.await(broken) : Effect.void)),
    ),
    facts: store.facts,
    goOn,
    subscribe: PubSub.subscribe(recorded),
    streamed: PubSub.subscribe(captured),
  };
});


/** The parts of the response to `turn`'s latest request that are known to have arrived: its tool calls. */
const arrivedIn = (facts: ReadonlyArray<Fact>, turn: TurnId): ReadonlyArray<ModelPart> => {
  const asked = facts.reduce(
    (found, fact, index) =>
      fact._tag === "Decided" &&
      (fact.decision._tag === "AskModel" || fact.decision._tag === "TellModel") &&
      fact.decision.turn === turn
        ? index
        : found,
    -1,
  );
  return facts.slice(asked + 1).flatMap((fact) =>
    fact._tag === "Observed" && fact.observation._tag === "ToolCallArrived" && fact.observation.turn === turn
      ? [{ _tag: "ToolCall" as const, call: fact.observation.call, tool: fact.observation.tool, input: fact.observation.input }]
      : [],
  );
};

/** The model `turn`'s latest request was made to, or, when none was made, the one the session asks. */
const askedIn = (
  facts: ReadonlyArray<Fact>,
  turn: TurnId,
): Effect.Effect<{ readonly provider: ProviderName; readonly model: ModelName }> => {
  const dispatched = facts
    .flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "ModelRequestDispatched" && fact.observation.turn === turn
        ? [fact.observation]
        : [],
    )
    .at(-1);
  return dispatched === undefined ? modelOf(facts) : Effect.succeed(dispatched);
};

/**
 * Ends the turn that `facts` leave running, in a `session` made from them. Facts can stop while a
 * turn runs, with requests made and no outcome recorded: the process that was carrying them out has
 * ended, and nobody will report how they went. The turn is interrupted, and each request under way
 * is given what is known of it: no response was observed (`Indeterminate`, with the tool calls that
 * had arrived), and how each call still running ended was not observed. No request is made again.
 * When the facts leave no turn running, nothing is recorded.
 */
export const endTurnLeftRunning = (session: Session): Effect.Effect<void, SessionStoreFailed, Services> =>
  Effect.gen(function* () {
    const facts = yield* session.facts;
    const world = worldOf(facts);
    const agent = world.agent.state;
    if (agent._tag !== "Running") return;
    const turn = agent.turn;
    const outcomes = notObserved(world, turn, yield* askedIn(facts, turn), arrivedIn(facts, turn));
    yield* Effect.forEach([{ _tag: "TurnInterrupted" as const, turn }, ...outcomes], session.observe, { discard: true }).pipe(
      reportedBy(harnessParts.resume),
    );
    yield* session.idle;
  });
