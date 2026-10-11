/**
 * A model client that tries providers in order: the target that the loop chose, then each fallback.
 * - It retries a target's send while the failure is retryable and came before the provider began to
 *   respond, up to `retries` (`retryMade` and `retryWait`, `provider-call.ts`).
 * - It moves to the next target only after a failure that means the provider cannot serve the
 *   request now (`fallsBackOn`), once that target is not retried again.
 * - Any other failure is a fault in the request or the configuration (credentials, an invalid
 *   request, content policy, output that the adapter could not read). Moving to another provider
 *   would hide it, so the request fails as it would with one provider.
 * - Each failure that the chain moves on from is recorded as it happens (`ModelAttemptFailed`,
 *   through `Report`) and logged. When the last target fails too, its failure is the request's
 *   outcome, `ModelFailed`.
 * - When a fallback answers, the chain reports a change of model to it (`ModelChangeArrived`), so
 *   the session asks that model first from then on (`ModelFromFacts`). When every target fails, the
 *   session's model does not change. The session never moves back to an earlier target by itself.
 * - A fallback that is the same as the chosen target is not tried again.
 *
 * Each try of a send runs in its own span, `agent.model.attempt`, with its provider and model, so a
 * target whose send is retried has a span for each try.
 *
 * `modelClientOf` is the same client over one provider's request and no fallbacks. It asks whatever
 * target it is given.
 *
 * The chain is an `ExecutionPlan` (`effect`, `@stability unstable` in 4.0.2), built for each request,
 * with one step for each target.
 * - A step provides its target and its prepared request (`FallbackStep`). The step prepares the
 *   request (`ProviderRequest`) when it first runs, and only once (`Effect.cached`): a fallback that
 *   is never tried is never prepared, and each retry makes the same send.
 * - A step has a schedule, and no `attempts` and no `while` predicate. Effect gives a step's schedule
 *   two kinds of failure, and each failed try carries the index of its step, so that the schedule
 *   tells them apart:
 *   - a failed try of its own step, which it retries or not, after the wait for that retry;
 *   - for a step after the first, the failure of the step before it, which it moves on from or not,
 *     with no wait.
 * - When it moves on, the schedule records the failed attempt with the target whose try failed, logs
 *   the fallback, and records the request to its own target (`ModelRequestDispatched`).
 * - When a step's schedule does not move on from a failure, Effect gives the same failure to each
 *   later step's schedule, which does not move on from it either, so the request fails with it.
 * - A try on a step after the first that answers records the change of model. It reads its step from
 *   the plan's metadata (`ExecutionPlan.CurrentMetadata`).
 *
 * The plan's `onEvent` observer is not used to record attempts: an `AttemptFailure` event does not
 * say whether the plan moves on, and Effect ignores the observer's own failures and defects.
 */

import { Context, Duration, Effect, ExecutionPlan, Layer, Ref, Schedule } from "effect";
import type * as AiError from "effect/ai/AiError";
import { FailureText, type ProviderName, type TurnId } from "../agent-machine/names.ts";
import { ModelClient, type ModelContext, type ProviderRequest, type ProviderSend, type Target } from "./contracts.ts";
import { logKeys } from "./log-keys.ts";
import { type Began, failedAs, markingBegan, receivedAiError, type RequestFailed, type Retries, retryMade, retryWait } from "./provider-call.ts";
import { harnessParts } from "./origin.ts";
import { Report } from "./report.ts";
import { sentAs } from "./sent.ts";

/** The `AiError` reasons after which the next provider is tried. */
export const fallsBackOn: ReadonlySet<AiError.AiErrorReason["_tag"]> = new Set([
  "NetworkError",
  "RateLimitError",
  "QuotaExhaustedError",
  "InternalProviderError",
]);

export interface FallbackChain {
  /** The request function through which each provider is reached. */
  readonly requests: ReadonlyMap<ProviderName, ProviderRequest>;
  /** The targets that a request goes to, in order, after the target that the loop chose. */
  readonly fallbacks: ReadonlyArray<Target>;
  /** How each target's send is retried before the chain moves on from it. */
  readonly retries: Retries;
}

/** A target, and the request function of its provider. */
interface Planned {
  readonly target: Target;
  readonly request: ProviderRequest;
}

/** The target of a step of a request's plan, and the step's prepared request. */
class FallbackStep extends Context.Service<FallbackStep, { readonly target: Target; readonly prepared: Effect.Effect<ProviderSend> }>()(
  "agent-session/FallbackStep",
) {}

/** A failed try: the index of the plan's step that made it, its target, its failure, and whether the provider had begun to respond. */
interface TryFailed extends Began<RequestFailed> {
  readonly step: number;
  readonly target: Target;
}

/** Returns the request function for `target`'s provider. A provider with no configured request is a configuration fault: a defect, not a failed request. */
const requestFor = (chain: FallbackChain, target: Target): Effect.Effect<ProviderRequest> => {
  const request = chain.requests.get(target.provider);
  return request === undefined
    ? Effect.die(new Error(`No request is configured for provider ${target.provider}`))
    : Effect.succeed(request);
};

const sameTarget = (a: Target, b: Target): boolean => a.provider === b.provider && a.model === b.model;

/** One try, at the target of the plan's current step. */
const attempt = Effect.gen(function* () {
  const { target, prepared } = yield* FallbackStep;
  const { stepIndex } = yield* ExecutionPlan.CurrentMetadata;
  const response = yield* markingBegan(yield* prepared).pipe(
    Effect.withSpan("agent.model.attempt", { attributes: { provider: target.provider, model: target.model } }),
    Effect.mapError((failed): TryFailed => ({ ...failed, step: stepIndex, target })),
  );
  if (stepIndex > 0) yield* (yield* Report)({ _tag: "ModelChangeArrived", provider: target.provider, model: target.model }, harnessParts.fallbackChain);
  return response;
});

/** Whether the step whose target is `to` moves on from `tried`, the failure of the step before it. When it does, it records and logs the move. */
const movesOn = (tried: TryFailed, to: Target, context: ModelContext, turn: TurnId): Effect.Effect<boolean> => {
  const { target: from, failed } = tried;
  const { error, request } = failed;
  return fallsBackOn.has(error.reason._tag)
    ? Effect.gen(function* () {
        const report = yield* Report;
        yield* report(
          {
            _tag: "ModelAttemptFailed",
            turn,
            provider: from.provider,
            model: from.model,
            failure: FailureText.make(error.message),
            error: receivedAiError(error),
            request,
          },
          { _tag: "Provider", provider: from.provider },
        );
        yield* Effect.logWarning(logKeys.provider.fellBack, {
          from: { provider: from.provider, model: from.model },
          to: { provider: to.provider, model: to.model },
          reason: error.reason._tag,
          message: error.message,
        });
        // The loop records the request to the target it chose; a request to a fallback is recorded here.
        yield* report(
          { _tag: "ModelRequestDispatched", turn, provider: to.provider, model: to.model, sent: sentAs(context) },
          harnessParts.fallbackChain,
        );
        return true;
      })
    : Effect.succeed(false);
};

/** The schedule of the step at `index`, whose target is `target` (see the module's description). `retried` counts the step's own failed tries. */
const scheduleOf = (index: number, target: Target, retries: Retries, retried: Ref.Ref<number>, context: ModelContext, turn: TurnId) =>
  Schedule.forever.pipe(
    Schedule.while(({ input }: Schedule.Metadata<number, TryFailed>) =>
      input.step === index
        ? Effect.flatMap(Ref.updateAndGet(retried, (count) => count + 1), (retry) =>
            retryMade(retries, { failed: input.failed.error, began: input.began }, retry),
          )
        : movesOn(input, target, context, turn),
    ),
    Schedule.modifyDelay(({ input }: Schedule.Metadata<number, TryFailed>) =>
      input.step === index ? Effect.flatMap(Ref.get(retried), (retry) => retryWait(retries, input.failed.error, retry)) : Effect.succeed(Duration.zero),
    ),
  );

/** Asks each of `planned` in order, as one plan (see the module's description), and returns the response or the failure as `ModelFailed`. */
const respondWith = (planned: readonly [Planned, ...ReadonlyArray<Planned>], retries: Retries, context: ModelContext, turn: TurnId) =>
  Effect.gen(function* () {
    const stepOf = ({ target, request }: Planned, index: number) =>
      Effect.gen(function* () {
        const prepared = yield* Effect.cached(Effect.suspend(() => request(target, context, turn)));
        const retried = yield* Ref.make(0);
        return { provide: Context.make(FallbackStep, { target, prepared }), schedule: scheduleOf(index, target, retries, retried, context, turn) };
      });
    const [chosen, ...fallbacks] = planned;
    const first = yield* stepOf(chosen, 0);
    const rest = yield* Effect.forEach(fallbacks, (each, index) => stepOf(each, index + 1));
    return yield* Effect.withExecutionPlan(attempt, ExecutionPlan.make(first, ...rest));
  }).pipe(Effect.catch(({ failed }) => failedAs(turn)(failed)));

/** The model client over `chain`. The fallbacks' providers are checked when the layer is built; the chosen target's provider is checked per request. */
export const FallbackModelClient = (chain: FallbackChain) =>
  Layer.effect(
    ModelClient,
    Effect.forEach(chain.fallbacks, (target) => requestFor(chain, target)).pipe(
      Effect.as(
        ModelClient.of({
          respond: (target, context, turn) =>
            Effect.gen(function* () {
              const chosen = { target, request: yield* requestFor(chain, target) };
              const fallbacks = yield* Effect.forEach(
                chain.fallbacks.filter((fallback) => !sameTarget(fallback, target)),
                (each) => Effect.map(requestFor(chain, each), (request) => ({ target: each, request })),
              );
              return yield* respondWith([chosen, ...fallbacks], chain.retries, context, turn);
            }),
        }),
      ),
    ),
  );

/** A model client over one provider's request and no fallbacks: it asks whatever target it is given, and retries the send as `retries` says. */
export const modelClientOf = (request: ProviderRequest, retries: Retries) =>
  ModelClient.of({ respond: (target, context, turn) => respondWith([{ target, request }], retries, context, turn) });
