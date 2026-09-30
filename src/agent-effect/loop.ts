/**
 * The loop around the core: it records each observation, asks the core what follows, records the
 * decisions, and carries out the requests, each of whose outcome is the next observation. The
 * session's facts are held in memory.
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
 * attributes; the observations that follow are recorded outside it. What happens during a request
 * besides its outcome (a failed attempt at it, say) is recorded at once through `Report`.
 *
 * Each fact is published as it is recorded; `subscribe` receives every fact recorded after it.
 * What a model request streams is passed on to `streamed` and not recorded.
 */

import { Clock, DateTime, Deferred, Effect, FiberSet, PubSub, Ref, type Scope, Semaphore } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import { notObserved } from "../agent-core/not-observed.ts";
import { deliver, emptyWorld, type World } from "../agent-core/router.ts";
import { InputText, Millis, type ModelName, type ProviderName, Seq, type SessionId, type TurnId } from "../agent-core/names.ts";
import type { CapturedObservation, ModelPart, Observation, ToolOutcome } from "../agent-core/observation.ts";
import type { Origin } from "../agent-core/origin.ts";
import type { EffectRequest } from "../agent-core/request.ts";
import { emptyHeld, type Held as Throttled, throttle, type ThrottleInput } from "../agent-core/throttle.ts";
import { ContextAssembler, ModelClient, ModelProvider, ToolRunner, TurnEndHooks, Turns } from "./contracts.ts";
import { logKeys } from "./log-keys.ts";
import { receivedJson } from "./received.ts";
import { ModelStream, ModelStreamInterval, type Streamed } from "./model-stream.ts";
import { CurrentOrigin, harnessParts, reportedBy } from "./origin.ts";
import { Report } from "./report.ts";
import { sentAs } from "./sent.ts";
import { modelOf } from "./session-setup.ts";
import { CurrentWork, type Work } from "./work.ts";

/**
 * The core's machines as `facts` leave them. Between turns they hold nothing: no turn runs, and the
 * machines of a turn that has ended are finished. So only what was recorded after the last turn
 * ended bears on them: input waiting for a turn, or a turn the facts leave running. Those
 * observations are delivered in order, and the machines' state is what is kept.
 */
const worldOf = (facts: ReadonlyArray<Fact>): World => {
  const ended = facts.reduce(
    (last, fact, index) => (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" ? index : last),
    -1,
  );
  return facts
    .slice(ended + 1)
    .reduce(
      (world, fact) => (fact._tag === "Observed" ? deliver(world, fact.seq, fact.observation).world : world),
      emptyWorld,
    );
};

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

/**
 * A session that goes on from `facts`: another session's, or this one's before its process ended.
 * This is all there is to resuming, because going on from facts that stop between turns is no
 * different from starting the next turn. The facts are kept as given, and everything a turn's
 * requests carry (the conversation, the model and its settings, the system prompt, the tools) is
 * read from them when the request is made. The machines start as the facts leave them (`worldOf`),
 * which between turns is as they start in a new session.
 *
 * The turns that start from here need identities the facts have not used: that is `Turns`' business.
 */
export const sessionFrom = (facts: ReadonlyArray<Fact>): Effect.Effect<Session, never, Scope.Scope> => Effect.gen(function* () {
  const held = yield* Ref.make<Held>({ world: worldOf(facts), facts, holds: new Map() });
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

  /** The signal that ends what `turn`'s requests are doing in the world, made when first asked for. */
  const cancelOf = (turn: TurnId): Effect.Effect<Deferred.Deferred<void>> =>
    Ref.modify(cancels, (now) => {
      const made = now.get(turn) ?? Deferred.makeUnsafe<void>();
      return [made, now.has(turn) ? now : new Map([...now, [turn, made]])];
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
            const facts = (yield* Ref.get(held)).facts;
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
        return Effect.gen(function* () {
          if (stop !== undefined && (yield* Deferred.isDone(stop))) return ended({ _tag: "Failed", reason: { _tag: "NotRun" } });
          yield* (yield* Report)({ _tag: "ToolCallDispatched", call: request.call }, harnessParts.toolRunner);
          const outcome = yield* (yield* ToolRunner)
            .run(request.tool, request.input)
            .pipe(Effect.raceFirst(stopped.pipe(Effect.as<ToolOutcome>({ _tag: "Failed", reason: { _tag: "Indeterminate" } }))));
          return ended(outcome);
        });
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
      const started = outcome.requests.map((request) => ({ request, work: about(request, now.world, now.facts) }));
      if (observation._tag !== "InputArrived" || now.world.agent.state._tag !== "Idle") return started;
      const turn = yield* (yield* Turns).start;
      return [...started, ...(yield* write(harnessParts.loop, { _tag: "TurnStarted", turn }))];
    });

  /** Carries out one request in the world and records each observation that comes of it. */
  const carry = ({ request, work }: Started): Effect.Effect<void, never, Services> =>
    Effect.gen(function* () {
      const services = yield* Effect.context<Services>();
      const report = (reported: Observation, by: Origin) => record(by, reported).pipe(Effect.provideContext(services));
      const stop = work.turn === undefined ? undefined : yield* cancelOf(work.turn);
      const observed = yield* carryOut(request, stop).pipe(
        Effect.withSpan(spanNames[request._tag], { attributes: { ...work } }),
        Effect.annotateLogs({ ...work }),
        Effect.provideService(CurrentWork, work),
        Effect.provideService(Report, report),
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

/** A session with no facts yet. */
export const openSession: Effect.Effect<Session, never, Scope.Scope> = sessionFrom([]);

/** The parts of the response to `turn`'s latest request that are known to have arrived: its tool calls. */
const arrivedIn = (facts: ReadonlyArray<Fact>, turn: TurnId): ReadonlyArray<ModelPart> => {
  const asked = facts.reduce(
    (found, fact, index) =>
      fact._tag === "Decided" && fact.decision._tag === "ModelAsked" && fact.decision.turn === turn ? index : found,
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
export const endTurnLeftRunning = (session: Session, facts: ReadonlyArray<Fact>): Effect.Effect<void, never, Services> =>
  Effect.gen(function* () {
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

/** A session that goes on from `facts`, with the turn they leave running, if any, ended. */
export const resumeSession = (facts: ReadonlyArray<Fact>): Effect.Effect<Session, never, Scope.Scope | Services> =>
  sessionFrom(facts).pipe(Effect.tap((session) => endTurnLeftRunning(session, facts)));
