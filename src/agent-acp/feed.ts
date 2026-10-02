/**
 * The live view of one open session: the session's facts (`subscribe`) and what its model requests
 * pass on (`streamed`), merged as they come into the projection (`projection.ts`, mode `live`), and
 * each update sent to the client as `session/update`, in the order the projection gives them. The
 * two feeds are subscribed to before anything is given to the session, so nothing of a turn is
 * missed; there is no order between them (PJ9).
 *
 * The feed also asks the client's permission: each `PermissionAsked` it takes is a
 * `session/request_permission` (`requestOf`), asked in a fiber of its own so the updates go on. The
 * answer (`answerOf`) is observed as `PermissionAnswered`. A client that fails the request, a
 * connection that closes, or an answer that fits no option counts as the reject-once option, and is
 * logged as a warning with its cause. A call that ends while its question is still out (its turn was
 * cancelled) has its request cancelled.
 *
 * `turnEnded(turn)` completes once the feed has taken the turn's `TurnEnded`: by then every update
 * of the turn has been written, so a prompt answers after them.
 */

import { type Context, Deferred, Effect, Fiber, PubSub, Queue, References, type Scope } from "effect";
import type { AgentConnection } from "../acp/agent.ts";
import type { V1Version } from "../acp/protocol.ts";
import type { SessionId, SessionUpdate } from "../acp/schema/v1.gen.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { type CallId, type TurnId, Via } from "../agent-machine/names.ts";
import type { Origin } from "../agent-machine/origin.ts";
import { answerPicking, OptionId, type PermissionQuestion, questionIn } from "../agent-policy/permissions.ts";
import type { Services, Session } from "../agent-session/loop.ts";
import { reportedBy } from "../agent-session/origin.ts";
import { logKeys } from "./log-keys.ts";
import { answerOf, InvalidAnswer, requestOf } from "./permission.ts";
import { next, type Present, type ProjectionInput, type ProjectionState, start } from "./projection.ts";

/** Who the host reports as: a person, through ACP. */
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
}

export interface Feed {
  /** Completes once the feed has taken `turn`'s `TurnEnded`, every update of the turn sent. */
  readonly turnEnded: (turn: TurnId) => Effect.Effect<void>;
}

/** The option that refuses this call once, which a failed or cancelled question picks. */
const rejectOnce = (question: PermissionQuestion) =>
  answerPicking(question.options.find((option) => option.kind === "reject_once")?.optionId ?? OptionId.make("reject-once"));

/** Starts the feed of `options.session` in the scope given; it runs until the scope closes. */
export const startFeed = (options: FeedOptions): Effect.Effect<Feed, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { sessionId, session, context, connection } = options;
    const facts = yield* session.subscribe;
    const streamed = yield* session.streamed;
    const inbox = yield* Queue.unbounded<ProjectionInput>();
    const ends = new Map<TurnId, Deferred.Deferred<void>>();
    const endOf = (turn: TurnId): Deferred.Deferred<void> => {
      const found = ends.get(turn);
      if (found !== undefined) return found;
      const made = Deferred.makeUnsafe<void>();
      ends.set(turn, made);
      return made;
    };
    const asking = new Map<CallId, Fiber.Fiber<void>>();
    let state: ProjectionState = start;
    let turn: TurnId | undefined;

    const send = (update: SessionUpdate) =>
      connection
        .notify("session/update", { sessionId, update })
        .pipe(Effect.catch((error) => Effect.logWarning(logKeys.update.notSent, { kind: update.sessionUpdate, cause: error.message })));

    const ask = (call: CallId, question: PermissionQuestion) =>
      Effect.gen(function* () {
        const known = state.calls.get(call);
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
              cause: "_tag" in error ? `${error._tag}: ${error.message}` : `${error.code}: ${error.message}`,
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
        Effect.annotateLogs({ call, ...(turn === undefined ? {} : { turn }) }),
        Effect.ensuring(Effect.sync(() => asking.delete(call))),
      );

    /** What the host does on a fact besides its updates: asks permission, cancels a question no call waits for, marks a turn's end. */
    const act = (fact: Fact) =>
      Effect.gen(function* () {
        if (fact._tag === "Decided") {
          if (fact.decision._tag === "TurnEnded") yield* Deferred.succeed(endOf(fact.decision.turn), undefined);
          return;
        }
        const observation = fact.observation;
        if (observation._tag === "TurnStarted") turn = observation.turn;
        if (observation._tag === "PermissionAsked") {
          const question = questionIn(observation.asks);
          if (question === undefined) return;
          const fiber = yield* Effect.forkScoped(ask(observation.call, question));
          asking.set(observation.call, fiber);
        }
        if (observation._tag === "ToolEnded") {
          const fiber = asking.get(observation.call);
          if (fiber !== undefined) yield* Effect.forkScoped(Fiber.interrupt(fiber));
        }
      });

    const take = (input: ProjectionInput) =>
      Effect.gen(function* () {
        const step = next(state, input, { mode: "live", present: options.present });
        state = step.state;
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
      turnEnded: (ended) =>
        Deferred.await(endOf(ended)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ends.delete(ended);
            }),
          ),
        ),
    };
  });
