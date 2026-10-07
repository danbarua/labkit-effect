/**
 * The loop around the core. For each observation, the loop writes the observation to the session's
 * store, delivers it to the core, writes the decisions that the core makes, and carries out the
 * requests that follow. Each request's outcome is the next observation. `docs/agent-session.md`
 * describes the loop in full.
 *
 * - **Writes.** Each fact is written before anything is done on it. That a request was made is
 *   recorded before the request goes out (`ModelRequestDispatched`, `ToolCallDispatched`). A write
 *   that fails stops the session: nothing after it is written, the requests under way are
 *   interrupted, and `observe`, `idle`, `prompt` and `cancel` fail with the reason.
 * - **Concurrency.** Observations are recorded one at a time, in the order they arrive. Each request
 *   runs in a fiber of its own, so the session takes further observations meanwhile; input waits in
 *   the core's mailboxes. Closing the session's scope ends the requests that are still running.
 * - **Stopping.** When the core asks for a turn's work to stop, each request under way ends what it
 *   is doing and reports how far it got: a model request reports the response as far as it arrived,
 *   and a tool run reports that its end was not observed.
 * - **Turns.** When input arrives while the agent is idle, the loop asks `Turns` for an identity and
 *   records `TurnStarted`.
 * - **Context for services.** While a request runs, `CurrentWork` holds the session, the turn, and
 *   for a tool run the call and the tool. Every log line written during the request is annotated
 *   with them, so the services that the request calls do not pass them along.
 * - **Spans.** The session is a span (`agent.session`) from when it opens until its scope closes.
 *   Each turn is a span under it (`agent.turn`) from `TurnStarted` until `TurnEnded`, or until the
 *   scope closes. Each request runs in a span named for its kind (`agent.model.request`,
 *   `agent.tool.run`, `agent.turn.review`) under its turn's span, or under the session's when the
 *   turn has no span (a turn started before the session was resumed). The observations that follow
 *   a request are recorded outside its span. The span annotations in place when the session opens
 *   (`Effect.annotateSpans`: a host's working folder and name, say) are on every span the session
 *   makes, whichever fiber starts it. When the session's span ends, it holds the totals of this
 *   opening: those of the facts recorded since the session opened over its store (`sessionTotals`,
 *   `accounting.ts`), not of the facts an earlier run recorded. A session continued from its facts
 *   (resumed, or loaded again) is a new span in a new trace, so a sum over session spans counts each
 *   request once.
 * - **Reports.** What happens during a request besides its outcome (a failed attempt, say) is
 *   recorded at once through `Report`.
 * - **Logs and subscribers.** Each fact is logged as it is recorded (`loop.observation.recorded`,
 *   `loop.decision.recorded`), and published: `subscribe` receives every fact recorded after it.
 *   What a model request streams is passed to `streamed` and is not recorded.
 *
 * `prompt` waits for the end of its turn by watching the facts recorded, not by `idle`, because
 * `idle` also waits for a tool call's permission question, which a host answers from another fiber
 * while `prompt` waits.
 */

import { keptOutcome } from "./blobs.ts";
import { Clock, DateTime, Deferred, Effect, Exit, FiberSet, Option, PubSub, Ref, References, type Scope, Semaphore, type Tracer } from "effect";
import { sessionTotals } from "./accounting.ts";
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
import { ContextAssembler, MaxHolds, ModelClient, ModelProvider, ModelRequestPolicies, type NamedPolicy, ToolCallPolicies, ToolRunner, TurnEndHooks, Turns } from "./contracts.ts";
import { every, type EveryState, type Policy, type PolicyStep, type Verdict } from "../agent-policy/policy.ts";
import type { Received } from "../agent-machine/received.ts";
import { logKeys } from "./log-keys.ts";
import { asText, receivedJson, receivedText } from "./received.ts";
import { ModelStream, ModelStreamInterval, type Streamed } from "./model-stream.ts";
import { CurrentOrigin, harnessParts, policyPart, reportedBy } from "./origin.ts";
import { holdsOf } from "./turn-holds.ts";
import { Report } from "./report.ts";
import { sentAs } from "./sent.ts";
import { immutableToolCatalogOf, modelOf } from "./configuration/session-setup.ts";
import { SessionStore, type SessionStoreFailed } from "./session-store.ts";
import { CurrentWork, type Work } from "./work.ts";

/**
 * Returns the core's machines as `facts` leave them. Between turns the machines hold nothing, so
 * only the facts recorded after the last turn ended affect them: input waiting for a turn, or a turn
 * that the facts leave running.
 */
const worldOf = (facts: ReadonlyArray<Fact>): World => worldAndRequestsOf(facts).world;

/**
 * Returns an observation in brief, for the log: each field that is text (its first 200 characters),
 * a number or a flag, and the tag of each field that has one (an outcome, an ending). Other fields
 * (a response's parts, what a request sent) are in the facts only.
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

/** Returns a delta as `streamed` gives it, its text branded for the kind of part it is added to. */
const deltaOf = (turn: TurnId, kind: "Text" | "Commentary" | "Thinking", text: string): CapturedObservation =>
  kind === "Thinking" ? { _tag: "ModelDelta", turn, kind, text: ThinkingText.make(text) } : { _tag: "ModelDelta", turn, kind, text: ModelText.make(text) };

/** Returns the id of the session that `facts` open, or undefined when they open none. */
const sessionOf = (facts: ReadonlyArray<Fact>): SessionId | undefined =>
  facts.flatMap((fact) =>
    fact._tag === "Observed" && fact.observation._tag === "SessionOpened" ? [fact.observation.session] : [],
  )[0];

/** Returns the turn under way: the latest turn started, when no `TurnEnded` is recorded for it. */
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

/** Takes facts from `facts` until `pick` returns a value for one, and returns that value. */
const firstMatching = <A>(facts: PubSub.Subscription<Fact>, pick: (fact: Fact) => Option.Option<A>): Effect.Effect<A> =>
  Effect.flatMap(PubSub.take(facts), (fact) => Option.match(pick(fact), { onNone: () => firstMatching(facts, pick), onSome: Effect.succeed }));

/** What the loop needs to carry out requests. */
export type Services = ModelProvider | ContextAssembler | ModelClient | Turns | ToolRunner;

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
   * turn that the facts left running (`leftRunning`) is under way until the host continues it or
   * ends it.
   */
  readonly turn: Effect.Effect<TurnId | undefined>;
  /**
   * Records `input` as the user's (`InputArrived`, with the origin `CurrentOrigin` gives) and
   * returns how the turn that took it ended. With no turn under way the loop starts one for it.
   * With one under way the input goes to that turn, which takes it between steps;
   * if that turn ends other than by an answer the input is dropped, and `prompt` returns that
   * ending all the same. Two at once are recorded one after the other, and both go to the same turn
   * unless it ends between them. It fails if writing the session's facts fails, then or while it
   * waits.
   */
  readonly prompt: (input: Prompt) => Effect.Effect<Ending, SessionStoreFailed, Services>;
  /**
   * Records `TurnInterrupted` for the turn under way, with the origin `CurrentOrigin` gives, and
   * returns once it is recorded; the turn ends `Interrupted` once its requests have reported how
   * far they got. With no turn under way it records nothing.
   */
  readonly cancel: Effect.Effect<void, SessionStoreFailed, Services>;
  /** Waits until no request is being carried out; fails if writing the session's facts failed. */
  readonly idle: Effect.Effect<void, SessionStoreFailed>;
  /** The session's facts, as its store keeps them. */
  readonly facts: Effect.Effect<ReadonlyArray<Fact>>;
  /**
   * Continues the turn that the facts left running (`leftRunning`): each request with no outcome is
   * carried out.
   * - A model request is made again.
   * - A tool call runs again only when its tool's `replay` is `safe` (it changes nothing). Any other
   *   call ends `Indeterminate` if it had begun, and `NotRun` if it had not, because what it would
   *   change may have changed since; the model looks before it asks again.
   * - A turn that was being stopped receives what is known of each request, and ends.
   * - Input that arrived with no turn started for it starts a turn.
   *
   * The alternative is `endTurnLeftRunning`; the host chooses.
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
 * Opens a session over the facts that its store keeps: a new session, or one that continues from
 * them. Continuing from facts that stop between turns is the same as starting the next turn, because
 * every request reads what it carries (the conversation, the model and its settings, the system
 * prompt, the tools) from the facts. The machines start as the facts leave them (`worldOf`).
 *
 * Facts that stop while a turn runs leave the turn under way with no one carrying out its requests.
 * The host continues it (`goOn`) or ends it (`endTurnLeftRunning`).
 *
 * `Turns` must give identities that the facts have not used.
 */
export const openSession: Effect.Effect<Session, never, Scope.Scope | SessionStore> = Effect.gen(function* () {
  const store = yield* SessionStore;
  const facts = yield* store.facts;
  // The host's span annotations, kept for the spans that other fibers start for the session.
  const annotations = yield* References.TracerSpanAnnotations;
  // Made before `running`, so closing the scope ends the requests' spans, then the turns', then this.
  const sessionSpan = yield* Effect.makeSpanScoped("agent.session");
  // A session continued from its facts records no opening again: its span is named from the facts.
  const continued = sessionOf(facts);
  if (continued !== undefined) sessionSpan.attribute("session", continued);
  // A turn's span stays here after it ends: requests that follow from its ending are still under it.
  const turnSpans = yield* Ref.make<ReadonlyMap<TurnId, Tracer.Span>>(new Map());
  // Added after the session's span, so it runs before the span ends.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeNanos;
      const open = [...(yield* Ref.get(turnSpans)).values()].filter((span) => span.status._tag === "Started");
      yield* Effect.forEach(open, (span) => Effect.sync(() => span.end(now, Exit.void)), { discard: true });
      // This opening's totals: the facts recorded since it opened, which an earlier opening's span did not count.
      const totals = sessionTotals((yield* store.facts).slice(facts.length));
      const attributes = {
        requests: totals.requests,
        failed_requests: totals.failedRequests,
        turns: totals.turns,
        tool_calls: totals.toolCalls,
        failed_tool_calls: totals.failedToolCalls,
        input_tokens: totals.inputTokens,
        output_tokens: totals.outputTokens,
        cache_read_tokens: totals.cacheReadTokens,
        cache_write_tokens: totals.cacheWriteTokens,
        ...(totals.cost === undefined ? {} : { cost_usd: totals.cost }),
        unpriced_requests: totals.unpricedRequests,
        models: totals.models.join(","),
      };
      yield* Effect.sync(() => Object.entries(attributes).forEach(([key, value]) => sessionSpan.attribute(key, value)));
    }),
  );
  /** Names the session on its span when it opens, opens a turn's span when it starts, and ends it when it ends. */
  const traceTurns = (observation: Observation, decisions: ReadonlyArray<Decision>, session: SessionId | undefined) =>
    Effect.gen(function* () {
      if (observation._tag === "SessionOpened") sessionSpan.attribute("session", observation.session);
      if (observation._tag === "TurnStarted") {
        const span = yield* Effect.makeSpan("agent.turn", {
          parent: sessionSpan,
          attributes: { ...annotations, ...(session === undefined ? {} : { session }), turn: observation.turn },
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
   * Writes `more` to the store. After a write fails, nothing more is written, and the requests under
   * way are interrupted.
   */
  const appendFacts = (more: ReadonlyArray<Fact>): Effect.Effect<void, SessionStoreFailed> =>
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
   * Returns the turn-end hooks' feedback as input, followed by the review. When the hooks have held
   * the turn `maxHolds` times, further feedback is not given to the turn: it is recorded
   * (`TurnHoldsExhausted`) and logged as a warning, followed by the review. With no feedback, the
   * review lets the turn end.
   */
  const reviewTurnEnd = (turn: TurnId): Effect.Effect<ReadonlyArray<Observed>, never, Services> =>
    Effect.gen(function* () {
      const hooks = yield* TurnEndHooks;
      const maxHolds = yield* MaxHolds;
      const facts = yield* store.facts;
      const holds = holdsOf(facts, turn);
      const origin = harnessParts.turnEndHooks;
      const reviewed: Observed = { origin, observation: { _tag: "TurnEndReviewed", turn } };
      const feedback = (yield* Effect.forEach(hooks, (hook) => hook(facts, turn))).flat();
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

  /** Returns the signal that stops `turn`'s requests, creating it on first use. */
  const cancelOf = (turn: TurnId): Effect.Effect<Deferred.Deferred<void>> =>
    Ref.modify(cancels, (now) => {
      const made = now.get(turn) ?? Deferred.makeUnsafe<void>();
      return [made, now.has(turn) ? now : new Map([...now, [turn, made]])];
    });

  /**
   * Carries out `request` and passes what it streams to `streamed`. Events, and the text they add to
   * parts, are held and released in batches at most once per `ModelStreamInterval`; a completed part
   * and the end of the request release what is held. The end of the request (`ModelResponseEnded`)
   * is passed last, however the request ended.
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
   * Returns the log details of a tool call that ended: the call, the tool, its input, and how it
   * ended, with what it returned or why it failed. Content is logged as its length and its first 300
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

  /** Returns the policies of `list` as the facts stand now, combined with `every`, and a function from a position to the policy's name. */
  const policiesNow = (list: ReadonlyArray<NamedPolicy>): Effect.Effect<{ readonly policy: Policy<EveryState>; readonly nameAt: (index: number | undefined) => string }> =>
    Effect.gen(function* () {
      const facts = yield* store.facts;
      const policy = every(yield* Effect.forEach(list, (entry) => entry.policy(facts)));
      return { policy, nameAt: (index) => (index === undefined ? "" : (list[index]?.name ?? "")) };
    });

  /**
   * Returns the tool call policies' verdict on a call, as the facts stand. While the policies wait,
   * each question is recorded (`PermissionAsked`), and the next answer recorded for the call
   * (`PermissionAnswered`) is given to them. A policy that waits without asking is a defect, because
   * nothing would answer it.
   */
  const reviewed = (
    request: Extract<EffectRequest, { _tag: "RunTool" }>,
  ): Effect.Effect<Exclude<Verdict, { _tag: "Veto" }> | (Extract<Verdict, { _tag: "Veto" }> & { readonly by: string }), never, Services> =>
    Effect.scoped(
      Effect.gen(function* () {
        const { policy, nameAt } = yield* policiesNow(yield* ToolCallPolicies);
        const answers = yield* PubSub.subscribe(recorded);
        const report = yield* Report;
        const answer = firstMatching(answers, (fact) =>
          fact._tag === "Observed" && fact.observation._tag === "PermissionAnswered" && fact.observation.call === request.call ? Option.some(fact.observation.answer) : Option.none(),
        );
        /** Returns the decided step that `step` reaches once each question is recorded and answered. */
        const decided = (step: PolicyStep<EveryState>): Effect.Effect<Extract<PolicyStep<EveryState>, { _tag: "Decided" }>> => {
          if (step._tag === "Decided") return Effect.succeed(step);
          if (step.asks === undefined) return Effect.die(new Error(`A tool call policy waited on ${request.call} without asking anything`));
          return report({ _tag: "PermissionAsked", call: request.call, asks: step.asks }, policyPart("tool call policy", nameAt(step.state.index))).pipe(
            Effect.andThen(answer),
            Effect.flatMap((answered) => decided(policy.receive(step.state, { _tag: "Answered", answer: answered }))),
          );
        };
        const step = yield* decided(policy.start(request));
        if (step.verdict._tag === "Veto")
          yield* Effect.logInfo(logKeys.loop.toolVetoed, { call: request.call, tool: request.tool, by: nameAt(step.by), reason: asText(step.verdict.reason) });
        return step.verdict._tag === "Veto" ? { ...step.verdict, by: nameAt(step.by) } : step.verdict;
      }),
    );

  /**
   * Carries out one request and returns the observations that come of it. `stop` completes when the
   * request's turn must stop its work; the request then ends what it is doing and reports how far it
   * got.
   */
  const carryOut = (
    request: EffectRequest,
    stop: Deferred.Deferred<void> | undefined,
  ): Effect.Effect<ReadonlyArray<Observed>, never, Services> => {
    const stopped = stop === undefined ? Effect.never : Deferred.await(stop);
    switch (request._tag) {
      case "RequestModelResponse":
        return Effect.gen(function* () {
          // The request is reviewed before a model is chosen for it: a vetoed request is not made, and streams nothing.
          const { policy, nameAt } = yield* policiesNow(yield* ModelRequestPolicies);
          const step = policy.start(request);
          // Nothing can wake a waiting model request policy yet, so a held request fails the turn, telling the user to wait.
          if (step._tag === "Waiting") {
            const asks = step.asks === undefined ? "" : ` ${asText(step.asks)}`;
            const failure = FailureText.make(`Not sent: a policy holds model requests for now. Wait, then try again.${asks}`);
            yield* Effect.logWarning(logKeys.loop.modelHeld, { turn: request.turn, failure });
            return [
              {
                origin: policyPart("model request policy", nameAt(step.state.index)),
                observation: { _tag: "ModelFailed", turn: request.turn, failure, error: step.asks ?? receivedText(failure) },
              } satisfies Observed,
            ];
          }
          if (step.verdict._tag === "Veto") {
            yield* Effect.logInfo(logKeys.loop.modelVetoed, { turn: request.turn, by: nameAt(step.by), reason: asText(step.verdict.reason) });
            return [{ origin: policyPart("model request policy", nameAt(step.by)), observation: { _tag: "ModelVetoed", turn: request.turn, reason: step.verdict.reason } } satisfies Observed];
          }
          return yield* passingOn(
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
        });
      case "RunTool": {
        const origin: Origin = { _tag: "Tool", tool: request.tool };
        const ended = (outcome: ToolOutcome): ReadonlyArray<Observed> => [
          { origin, observation: { _tag: "ToolEnded", call: request.call, outcome } },
        ];
        const notRun = ended({ _tag: "Failed", reason: { _tag: "NotRun" } });
        const vetoed = (reason: Received, by: string): ReadonlyArray<Observed> => [
          { origin: policyPart("tool call policy", by), observation: { _tag: "ToolEnded", call: request.call, outcome: { _tag: "Failed", reason: { _tag: "Vetoed", reason } } } },
        ];
        return Effect.gen(function* () {
          if (stop !== undefined && (yield* Deferred.isDone(stop))) return notRun;
          const verdict = yield* reviewed(request).pipe(Effect.raceFirst(stopped.pipe(Effect.as("stopped" as const))));
          if (verdict === "stopped") return notRun;
          if (verdict._tag === "Veto") return vetoed(verdict.reason, verdict.by);
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
        // An interrupted turn asks the model nothing more: its hooks are stopped, their feedback is
        // not given, and the review reports at once so that the turn ends.
        return reviewTurnEnd(request.turn).pipe(
          Effect.raceFirst(
            stopped.pipe(
              Effect.andThen(Effect.logInfo(logKeys.loop.reviewStopped, { turn: request.turn })),
              Effect.as<ReadonlyArray<Observed>>([{ origin: harnessParts.loop, observation: { _tag: "TurnEndReviewed", turn: request.turn } }]),
            ),
          ),
        );
      case "StopTurnWork":
        return cancelOf(request.turn).pipe(
          Effect.flatMap((cancel) => Deferred.succeed(cancel, undefined)),
          Effect.as([]),
        );
      default:
        return request satisfies never;
    }
  };

  /** Returns what a request is about: the session that the facts open, and the request's turn, call and tool. */
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
   * follow, each with what it is about. Callers hold `lock`, so one observation is recorded at a time.
   */
  const write = (origin: Origin, observation: Observation): Effect.Effect<ReadonlyArray<Started>, SessionStoreFailed, Services> =>
    Effect.gen(function* () {
      const before = yield* store.facts;
      const seq = Seq.make(before.length + 1);
      const time = yield* DateTime.now;
      const observed: Fact = { _tag: "Observed", seq, time, origin, observation };
      // The observation is written before the core decides on it, and the decisions before anything
      // follows from them.
      yield* appendFacts([observed]);
      const outcome = deliver(yield* Ref.get(machines), seq, observation);
      const decided = outcome.decisions.map(
        (decision, index): Fact => ({ _tag: "Decided", seq: Seq.make(seq + 1 + index), time, decision }),
      );
      yield* appendFacts(decided);
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

  /** Carries out one request and records each observation that comes of it. */
  const carry = ({ request, work }: Started): Effect.Effect<void, never, Services> =>
    Effect.gen(function* () {
      const services = yield* Effect.context<Services>();
      // A report that cannot be written interrupts the request, so it does not do what it reported.
      const report = (reported: Observation, by: Origin) =>
        record(by, reported).pipe(Effect.provideContext(services), Effect.catchTag("SessionStoreFailed", () => Effect.interrupt));
      const stop = work.turn === undefined ? undefined : yield* cancelOf(work.turn);
      // The parent span and the annotations are set explicitly: this fiber was started from whichever fiber recorded the observation.
      const parent = (work.turn === undefined ? undefined : (yield* Ref.get(turnSpans)).get(work.turn)) ?? sessionSpan;
      const observed = yield* carryOut(request, stop).pipe(
        Effect.withSpan(spanNames[request._tag], { attributes: { ...work } }),
        Effect.withParentSpan(parent),
        Effect.annotateSpans(annotations),
        Effect.annotateLogs({ ...work }),
        Effect.provideService(CurrentWork, work),
        Effect.provideService(Report, report),
      );
      yield* Effect.forEach(observed, (each) => record(each.origin, each.observation), { discard: true });
    }).pipe(
      // A request that dies of a defect (a provider with no client configured, say) is logged with
      // the defect, and an outcome is recorded for it, so that its turn still ends: a model request
      // failed, a tool's end was not observed, or a turn-end review gave nothing more.
      Effect.catchDefect((defect) => {
        // The stack is logged separately from the name and message, because whether a stack starts with the message depends on the runtime.
        const died = String(defect);
        const stack = defect instanceof Error ? defect.stack : undefined;
        const recorded = stack === undefined ? died : `${died}\n${stack}`;
        const outcome = ((): Observation | undefined => {
          switch (request._tag) {
            case "RequestModelResponse":
              return {
                _tag: "ModelFailed",
                turn: request.turn,
                failure: FailureText.make(`The request died: ${defect instanceof Error ? defect.message : String(defect)}`),
                error: receivedText(recorded),
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
        return Effect.logError(logKeys.loop.requestDied, { request: request._tag, ...work, defect: died, ...(stack === undefined ? {} : { stack }) }).pipe(
          Effect.andThen(outcome === undefined ? Effect.void : record(harnessParts.loop, outcome)),
        );
      }),
      // A failed write was logged where it failed, and the session has stopped.
      Effect.catchTag("SessionStoreFailed", () => Effect.void),
    );

  /**
   * Runs `step`, which records observations, while holding `lock`; then starts each request that
   * `step` returns in a fiber of its own, and returns `step`'s other result.
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

  /** Returns the origin that `CurrentOrigin` gives. An observation given with no origin set is a defect. */
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
        // The input is built from `input`'s fields only, so other fields of the caller's value are not recorded.
        const arrived: Observation = {
          _tag: "InputArrived",
          from: { _tag: "User" },
          text: input.text,
          ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
        };
        // The turn that took the input is read while the lock is held: the turn under way, or the
        // turn started for it. Input in a turn's mailbox is taken by that turn or dropped when it ends.
        const turn = yield* recording(
          Effect.gen(function* () {
            const started = yield* write(origin, arrived);
            const agent = (yield* Ref.get(machines)).agent.state;
            return [started, agent._tag === "Running" ? agent.turn : undefined] as const;
          }),
        );
        if (turn === undefined) return yield* Effect.die(new Error("No turn was under way or started for the input given to prompt"));
        const ended = firstMatching(fromNow, (fact) =>
          fact._tag === "Decided" && fact.decision._tag === "TurnEnded" && fact.decision.turn === turn ? Option.some(fact.decision.ending) : Option.none(),
        );
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


/** Returns the tool calls of the response to `turn`'s latest request that are known to have arrived. */
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

/** Returns the model that `turn`'s latest request was made to, or the session's model when no request was made. */
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
 * Ends the turn that the session's facts leave running. Facts can stop while a turn runs, with
 * requests made and no outcome recorded, because the process that was carrying them out has ended.
 * The turn is interrupted, and each request under way receives what is known of it: a model request
 * gets no response (`Indeterminate`, with the tool calls that had arrived), a running tool call
 * gets an end that was not observed, and a turn-end review gets `TurnEndReviewed` with no input
 * from the hooks. No request is made again. When the facts leave no turn
 * running, nothing is recorded.
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
