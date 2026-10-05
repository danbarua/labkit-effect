/**
 * The live view of one open session.
 *
 * - The feed merges the session's facts (`subscribe`) and what its model requests pass on
 *   (`streamed`), as they arrive, into the projection (`projection.ts`, mode `live`), and sends each
 *   update to the client as `session/update`, in the order the projection returns them.
 * - It subscribes to both before anything is given to the session, so nothing of a turn is missed.
 *   The two have no order between them; the projection sends the same text whatever the merge.
 * - Each `PermissionAsked` it takes is asked of the client as `session/request_permission`
 *   (`requestOf`), in a fiber of its own so the updates go on. The answer (`answerOf`) is recorded
 *   as `PermissionAnswered`.
 * - A client that fails the request, a connection that closes, or an answer that fits no option
 *   counts as the reject-once option, and is logged as a warning with its cause.
 * - A call that ends while its question is still out (its turn was cancelled) has its request
 *   cancelled.
 * - `turnEnded(turn)` completes once the feed has taken the turn's `TurnEnded`. By then every update
 *   of the turn has been sent, so a prompt answers after them.
 */

import { type Context, Deferred, Effect, Fiber, HashMap, Option, PubSub, Queue, Ref, References, type Scope } from "effect";
import type { AgentConnection } from "effective-acp/agent";
import type { V1Version } from "effective-acp/protocol";
import type { SessionId, SessionUpdate } from "effective-acp/schema/v1";
import type { Fact } from "../agent-machine/fact.ts";
import { type CallId, type TurnId, Via } from "../agent-machine/names.ts";
import type { Origin } from "../agent-machine/origin.ts";
import { answerPicking, OptionId, type PermissionQuestion, questionIn } from "../agent-policy/permissions.ts";
import type { Services, Session } from "../agent-session/loop.ts";
import { reportedBy } from "../agent-session/origin.ts";
import { logKeys } from "./log-keys.ts";
import { answerOf, InvalidAnswer, requestOf } from "./permission.ts";
import { next, type Present, type ProjectionInput, type ProjectionState, start } from "./projection.ts";

/** The origin that the host records observations with: a person, through ACP. */
export const acpUser: Origin = { _tag: "User", via: Via.make("acp") };

export interface FeedOptions {
  readonly sessionId: SessionId;
  readonly session: Session;
  /** What the session's operations run with. */
  readonly context: Context.Context<Services>;
  readonly present: Present;
  readonly connection: AgentConnection<V1Version>;
  /** The log annotations of everything the feed logs (the connection and the session). */
  readonly annotations: Readonly<Record<string, unknown>>;
  /**
   * The projection's state to continue from: the state of the facts that the session had before the
   * feed (a loaded session's, projected), so nothing they showed is shown again. `start` when left out.
   */
  readonly initial?: ProjectionState | undefined;
}

export interface Feed {
  /** Completes once the feed has taken `turn`'s `TurnEnded` and sent every update of the turn. */
  readonly turnEnded: (turn: TurnId) => Effect.Effect<void>;
}

/** Returns the answer that picks the option refusing this call once, which a failed or cancelled question records. */
const rejectOnce = (question: PermissionQuestion) =>
  answerPicking(question.options.find((option) => option.kind === "reject_once")?.optionId ?? OptionId.make("reject-once"));

/** Starts the feed of `options.session` in the scope given; it runs until the scope closes. */
export const startFeed = (options: FeedOptions): Effect.Effect<Feed, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { sessionId, session, context, connection } = options;
    const facts = yield* session.subscribe;
    const streamed = yield* session.streamed;
    const inbox = yield* Queue.unbounded<ProjectionInput>();
    // For each turn, a signal that completes when the feed takes the turn's end; made when first asked for.
    const ends = yield* Ref.make(HashMap.empty<TurnId, Deferred.Deferred<void>>());
    const endOf = (turn: TurnId): Effect.Effect<Deferred.Deferred<void>> =>
      Ref.modify(ends, (all) =>
        Option.match(HashMap.get(all, turn), {
          onSome: (found) => [found, all] as const,
          onNone: () => {
            const made = Deferred.makeUnsafe<void>();
            return [made, HashMap.set(all, turn, made)] as const;
          },
        }),
      );
    // For each call, the fiber that asks its question while the question is out.
    const asking = yield* Ref.make(HashMap.empty<CallId, Fiber.Fiber<void>>());
    const state = yield* Ref.make<ProjectionState>(options.initial ?? start);
    // The turn under way: the turn of the last `TurnStarted` taken.
    const turn = yield* Ref.make<TurnId | undefined>(undefined);

    const send = (update: SessionUpdate) =>
      connection
        .notify("session/update", { sessionId, update })
        .pipe(Effect.catch((error) => Effect.logWarning(logKeys.update.notSent, { kind: update.sessionUpdate, cause: error.message })));

    const ask = (call: CallId, question: PermissionQuestion, during: TurnId | undefined) =>
      Effect.gen(function* () {
        const known = (yield* Ref.get(state)).calls.get(call);
        const answer = yield* Effect.gen(function* () {
          // The projection announces a call before its question (`ToolCallArrived` is recorded first).
          if (known === undefined) {
            yield* Effect.logWarning(logKeys.permission.failed, {
              tool: question.tool,
              doing: "presenting the call to ask about",
              cause: "the call was never announced",
              answer: "reject_once",
            });
            return rejectOnce(question);
          }
          yield* Effect.logInfo(logKeys.permission.asked, { tool: question.tool, options: question.options.map((option) => option.optionId) });
          const asked = yield* connection.client["session/request_permission"](requestOf(sessionId, known.call, question, known.shown)).pipe(Effect.result);
          if (asked._tag === "Failure") {
            const error = asked.failure;
            yield* Effect.logWarning(logKeys.permission.failed, {
              tool: question.tool,
              doing: "asking the client session/request_permission",
              cause: `${error._tag}: ${error.message}`,
              answer: "reject_once",
            });
            return rejectOnce(question);
          }
          const picked = answerOf(asked.success, question);
          if (picked instanceof InvalidAnswer) {
            yield* Effect.logWarning(logKeys.permission.failed, {
              tool: question.tool,
              doing: "reading the client's answer to session/request_permission",
              cause: picked.reason,
              answer: "reject_once",
            });
            return rejectOnce(question);
          }
          const outcome = asked.success.outcome;
          yield* Effect.logInfo(logKeys.permission.answered, {
            tool: question.tool,
            outcome: outcome.outcome,
            ...(outcome.outcome === "selected" ? { option: outcome.optionId } : {}),
          });
          return picked;
        });
        yield* session.observe({ _tag: "PermissionAnswered", call, answer }).pipe(
          Effect.provideContext(context),
          reportedBy(acpUser),
          Effect.catchTag("SessionStoreFailed", (error) =>
            Effect.logError(logKeys.permission.failed, { tool: question.tool, doing: "recording the answer", cause: error.message }),
          ),
        );
      }).pipe(
        Effect.annotateLogs({ call, ...(during === undefined ? {} : { turn: during }) }),
        Effect.ensuring(Ref.update(asking, HashMap.remove(call))),
      );

    /** Acts on a fact beyond its updates: asks permission, cancels a question that no call waits for, and marks a turn's end. */
    const act = (fact: Fact) =>
      Effect.gen(function* () {
        if (fact._tag === "Decided") {
          if (fact.decision._tag === "TurnEnded") yield* Deferred.succeed(yield* endOf(fact.decision.turn), undefined);
          return;
        }
        const observation = fact.observation;
        if (observation._tag === "TurnStarted") yield* Ref.set(turn, observation.turn);
        if (observation._tag === "PermissionAsked") {
          const question = questionIn(observation.asks);
          if (question === undefined) return;
          const fiber = yield* Effect.forkScoped(ask(observation.call, question, yield* Ref.get(turn)));
          yield* Ref.update(asking, HashMap.set(observation.call, fiber));
        }
        if (observation._tag === "ToolEnded") {
          const fiber = HashMap.get(yield* Ref.get(asking), observation.call);
          if (Option.isSome(fiber)) yield* Effect.forkScoped(Fiber.interrupt(fiber.value));
        }
      });

    const take = (input: ProjectionInput) =>
      Effect.gen(function* () {
        const step = yield* next(yield* Ref.get(state), input, { mode: "live", present: options.present });
        yield* Ref.set(state, step.state);
        yield* Effect.forEach(step.updates, send, { discard: true });
        if (input._tag === "Observed" || input._tag === "Decided") yield* act(input);
      }).pipe(
        // A defect in one input (a presentation that throws) is logged; the feed goes on with the next.
        Effect.catchDefect((defect) => Effect.logError(logKeys.update.notSent, { input: input._tag, cause: String(defect) })),
      );

    const forward = <A extends ProjectionInput>(subscription: PubSub.Subscription<A>) =>
      Effect.forever(PubSub.take(subscription).pipe(Effect.flatMap((item) => Queue.offer(inbox, item))));

    const annotated = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, References.CurrentLogAnnotations, options.annotations);
    yield* Effect.forkScoped(annotated(forward(facts)));
    yield* Effect.forkScoped(annotated(forward(streamed)));
    yield* Effect.forkScoped(annotated(Effect.forever(Queue.take(inbox).pipe(Effect.flatMap(take)))));

    return {
      turnEnded: (ended) => Effect.flatMap(endOf(ended), Deferred.await).pipe(Effect.ensuring(Ref.update(ends, HashMap.remove(ended)))),
    };
  });
