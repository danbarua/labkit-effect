/**
 * The loop around the core: it records each observation, asks the core what follows, records the
 * decisions, and carries out the requests, each of whose outcome is the next observation. The
 * session's facts are held in memory.
 *
 * Observations are recorded one at a time, in the order they arrive. Each request is carried out
 * in a fiber of its own, so the session takes further observations meanwhile: input is queued in
 * the core's mailboxes, and an interruption ends the turn and the work its requests are doing in
 * the world. `idle` waits until no request is being carried out. The session lives in a scope;
 * closing it ends whatever is still being carried out.
 *
 * When a turn starts is decided here: when input arrives and the agent is idle, the loop starts a
 * turn through `Turns` and reports `TurnStarted`.
 *
 * While a request is carried out, `CurrentWork` says what it is about (the session, its turn, and
 * for a tool run its call and tool), and every log line written is annotated with the same, so the
 * services it calls do not pass those along themselves. Each request is carried out in a span named
 * for its kind (`agent.model.request`, `agent.tool.run`, `agent.turn.review`), with the same as its
 * attributes; the observations that follow are recorded outside it. What happens during a request
 * besides its outcome (a failed attempt at it, say) is recorded at once through `Report`.
 *
 * Each fact is published as it is recorded; `subscribe` receives every fact recorded after it.
 * What a model request streams is passed on to `streamed` and not recorded.
 */

import { Clock, DateTime, Deferred, Effect, FiberSet, PubSub, Ref, type Scope, Semaphore } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import { deliver, emptyWorld, type World } from "../agent-core/router.ts";
import { InputText, Millis, Seq, type SessionId, type TurnId } from "../agent-core/names.ts";
import type { CapturedObservation, Observation } from "../agent-core/observation.ts";
import type { Origin } from "../agent-core/origin.ts";
import type { EffectRequest } from "../agent-core/request.ts";
import { emptyHeld, type Held as Throttled, throttle, type ThrottleInput } from "../agent-core/throttle.ts";
import { ContextAssembler, ModelClient, ModelProvider, ToolRunner, TurnEndHooks, Turns } from "./contracts.ts";
import { logKeys } from "./log-keys.ts";
import { ModelStream, ModelStreamInterval, type Streamed } from "./model-stream.ts";
import { CurrentOrigin, harnessParts } from "./origin.ts";
import { Report } from "./report.ts";
import { CurrentWork, type Work } from "./work.ts";

/** The session the facts opened, if they have. */
const sessionOf = (facts: ReadonlyArray<Fact>): SessionId | undefined =>
  facts.flatMap((fact) =>
    fact._tag === "Observed" && fact.observation._tag === "SessionOpened" ? [fact.observation.session] : [],
  )[0];

/** The span each kind of request is carried out in. */
const spanNames: Record<EffectRequest["_tag"], string> = {
  RequestModelResponse: "agent.model.request",
  RunTool: "agent.tool.run",
  BeforeTurnEnded: "agent.turn.review",
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

interface Held {
  readonly world: World;
  /** How many times turn-end hooks have held each turn open. */
  readonly holds: ReadonlyMap<TurnId, number>;
  readonly facts: ReadonlyArray<Fact>;
}

type Services = ModelProvider | ContextAssembler | ModelClient | Turns | ToolRunner | TurnEndHooks;

export interface Session {
  /**
   * Records an observation, with the origin `CurrentOrigin` gives, and starts what follows from it.
   * It returns once the observation is recorded; the requests that follow are carried out after.
   */
  readonly observe: (observation: Observation) => Effect.Effect<void, never, Services>;
  /** Waits until no request is being carried out. */
  readonly idle: Effect.Effect<void>;
  readonly facts: Effect.Effect<ReadonlyArray<Fact>>;
  /** Every fact recorded from now on, in order, for as long as the scope lasts. */
  readonly subscribe: Effect.Effect<PubSub.Subscription<Fact>, never, Scope.Scope>;
  /**
   * What model requests pass on while their responses stream, from now on and for as long as the
   * scope lasts: stream events, held and released in batches, and each part as it is completed.
   * None of it is recorded.
   */
  readonly streamed: Effect.Effect<PubSub.Subscription<CapturedObservation>, never, Scope.Scope>;
}

export const openSession: Effect.Effect<Session, never, Scope.Scope> = Effect.gen(function* () {
  const held = yield* Ref.make<Held>({ world: emptyWorld, facts: [], holds: new Map() });
  const recorded = yield* PubSub.unbounded<Fact>();
  const captured = yield* PubSub.unbounded<CapturedObservation>();
  const lock = yield* Semaphore.make(1);
  const running = yield* FiberSet.make<void, never>();
  const cancels = yield* Ref.make<ReadonlyMap<TurnId, Deferred.Deferred<void>>>(new Map());

  /**
   * The turn-end hooks' feedback as input, then the review. After `maxHolds` holds the hooks are not
   * run; that is recorded (`TurnHoldsExhausted`), then the review.
   */
  const reviewTurnEnd = (turn: TurnId): Effect.Effect<ReadonlyArray<Observed>, never, Services> =>
    Effect.gen(function* () {
      const { hooks, maxHolds } = yield* TurnEndHooks;
      const holds = (yield* Ref.get(held)).holds.get(turn) ?? 0;
      const origin = harnessParts.turnEndHooks;
      const reviewed: Observed = { origin, observation: { _tag: "TurnEndReviewed", turn } };
      if (hooks.length > 0 && holds >= maxHolds) {
        yield* Effect.logWarning(logKeys.loop.holdsExhausted, { holds, maxHolds });
        return [{ origin, observation: { _tag: "TurnHoldsExhausted", turn, holds } }, reviewed];
      }
      const feedback = (yield* Effect.forEach(hooks, (hook) => hook(turn))).flat();
      if (feedback.length === 0) return [reviewed];
      yield* Ref.update(held, (now) => ({ ...now, holds: new Map([...now.holds, [turn, holds + 1]]) }));
      yield* Effect.logInfo(logKeys.loop.turnHeld, { hold: holds + 1, maxHolds, feedback: feedback.length });
      const inputs = feedback.map(
        (text): Observed => ({
          origin,
          observation: { _tag: "InputArrived", from: { _tag: "System" }, text: InputText.make(text) },
        }),
      );
      return [...inputs, reviewed];
    });

  /**
   * Carries out `request` with what it streams passed on to `streamed`: events held and released in
   * batches at most once per `ModelStreamInterval`; a completed part, and the end of the request,
   * release what is held.
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
      const sink = (streamed: Streamed) =>
        streamed._tag === "Chunk"
          ? step((at) => [{ _tag: "Captured", item: { _tag: "ModelStreamed", turn, chunk: streamed.chunk }, at }])
          : step((at) => [
              { _tag: "Captured", item: { _tag: "ModelPartArrived", turn, part: streamed.part }, at },
              { _tag: "Ended", at },
            ]);
      return yield* request.pipe(
        Effect.provideService(ModelStream, sink),
        Effect.ensuring(step((at) => [{ _tag: "Ended", at }])),
      );
    });

  const carryOut = (request: EffectRequest): Effect.Effect<ReadonlyArray<Observed>, never, Services> => {
    switch (request._tag) {
      case "RequestModelResponse":
        return passingOn(
          request.turn,
          Effect.gen(function* () {
          const facts = (yield* Ref.get(held)).facts;
          const target = yield* (yield* ModelProvider).select(facts, request.turn);
          const context = yield* (yield* ContextAssembler).assemble(facts, request.turn);
          const outcome = yield* (yield* ModelClient).respond(target, context, request.turn);
          // A response names the provider that gave it, which a fallback makes another than the one asked.
          const provider = outcome._tag === "ModelResponded" ? outcome.provider : target.provider;
          return [{ origin: { _tag: "Provider", provider }, observation: outcome } satisfies Observed];
          }),
        );
      case "RunTool":
        return Effect.gen(function* () {
          const outcome = yield* (yield* ToolRunner).run(request.tool, request.input);
          return [
            { origin: { _tag: "Tool", tool: request.tool }, observation: { _tag: "ToolEnded", call: request.call, outcome } },
          ];
        });
      case "BeforeTurnEnded":
        return reviewTurnEnd(request.turn);
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
        return { ...session, turn: request.turn };
      default:
        return request satisfies never;
    }
  };

  /** The signal that ends what `turn`'s requests are doing in the world, made when first asked for. */
  const cancelOf = (turn: TurnId): Effect.Effect<Deferred.Deferred<void>> =>
    Ref.modify(cancels, (now) => {
      const made = now.get(turn) ?? Deferred.makeUnsafe<void>();
      return [made, now.has(turn) ? now : new Map([...now, [turn, made]])];
    });

  /**
   * Records the observation and the decisions that follow from it, and returns the requests that
   * follow, each with what it is about. One observation is recorded at a time: callers hold `lock`.
   * A turn interrupted has its requests' work in the world ended.
   */
  const write = (origin: Origin, observation: Observation): Effect.Effect<ReadonlyArray<Started>, never, Services> =>
    Effect.gen(function* () {
      const before = yield* Ref.get(held);
      const seq = Seq.make(before.facts.length + 1);
      const outcome = deliver(before.world, seq, observation);
      const time = yield* DateTime.now;
      const facts: ReadonlyArray<Fact> = [
        { _tag: "Observed", seq, time, origin, observation },
        ...outcome.decisions.map((decision, index): Fact => ({
          _tag: "Decided",
          seq: Seq.make(seq + 1 + index),
          time,
          decision,
        })),
      ];
      const now = yield* Ref.updateAndGet(held, (current) => ({
        ...current,
        world: outcome.world,
        facts: [...before.facts, ...facts],
      }));
      yield* PubSub.publishAll(recorded, facts);
      const session = sessionOf(now.facts);
      yield* Effect.forEach(facts, (fact) =>
        fact._tag === "Decided"
          ? Effect.logInfo(logKeys.loop.decisionRecorded, {
              decision: fact.decision._tag,
              seq: fact.seq,
              after: seq,
              details: fact.decision,
            }).pipe(Effect.annotateLogs(session === undefined ? {} : { session }))
          : Effect.void,
      );
      yield* Effect.forEach(outcome.decisions, (decision) =>
        decision._tag === "TurnEnded" && decision.ending._tag === "Interrupted"
          ? cancelOf(decision.turn).pipe(Effect.flatMap((cancel) => Deferred.succeed(cancel, undefined)))
          : Effect.void,
      );
      const started = outcome.requests.map((request) => ({ request, work: about(request, now.world, now.facts) }));
      if (observation._tag !== "InputArrived" || now.world.agent.state._tag !== "Idle") return started;
      const turn = yield* (yield* Turns).start;
      return [...started, ...(yield* write(harnessParts.loop, { _tag: "TurnStarted", turn }))];
    });

  /**
   * Carries out one request in the world and records each observation that comes of it. The work in
   * the world ends when the request's turn is interrupted; what it had already returned is recorded.
   */
  const carry = ({ request, work }: Started): Effect.Effect<void, never, Services> =>
    Effect.gen(function* () {
      const services = yield* Effect.context<Services>();
      const report = (reported: Observation, by: Origin) => record(by, reported).pipe(Effect.provideContext(services));
      const cancelled: Effect.Effect<ReadonlyArray<Observed>> =
        work.turn === undefined
          ? Effect.never
          : cancelOf(work.turn).pipe(Effect.flatMap((cancel) => Deferred.await(cancel)), Effect.as([]));
      const observed = yield* carryOut(request).pipe(
        Effect.withSpan(spanNames[request._tag], { attributes: { ...work } }),
        Effect.annotateLogs({ ...work }),
        Effect.provideService(CurrentWork, work),
        Effect.provideService(Report, report),
        Effect.raceFirst(cancelled),
      );
      yield* Effect.forEach(observed, (each) => record(each.origin, each.observation), { discard: true });
    });

  /** Records the observation, then starts each request that follows in a fiber of its own. */
  const record = (origin: Origin, observation: Observation): Effect.Effect<void, never, Services> =>
    write(origin, observation).pipe(
      Semaphore.withPermit(lock),
      Effect.flatMap((started) => Effect.forEach(started, (each) => FiberSet.run(running, carry(each)), { discard: true })),
      Effect.uninterruptible,
    );

  const observe = (observation: Observation): Effect.Effect<void, never, Services> =>
    Effect.gen(function* () {
      const origin = yield* CurrentOrigin;
      if (origin === undefined)
        return yield* Effect.die(new Error(`${observation._tag} was given to a session with no origin set`));
      yield* record(origin, observation);
    });

  return {
    observe,
    idle: FiberSet.awaitEmpty(running),
    facts: Ref.get(held).pipe(Effect.map((current) => current.facts)),
    subscribe: PubSub.subscribe(recorded),
    streamed: PubSub.subscribe(captured),
  };
});
