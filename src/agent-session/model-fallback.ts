/**
 * A model client that tries providers in order: the target that the loop chose, then each fallback.
 * - It moves to the next target only after a failure that means the provider cannot serve the
 *   request now (`fallsBackOn`): it is unreachable, or refuses to serve the request. This is after
 *   the adapter's own retries, and only when the attempt had passed nothing on (`ModelStream`): no
 *   text, commentary or thinking, and no part of the response.
 * - A failure after the attempt passed something on fails the request, whatever its reason: what the
 *   response passed on, and any tool call it started, belong to that response, and another provider
 *   would answer the request as a new one. The session's next request goes through the chain again.
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
 * Each attempt runs in a span, `agent.model.attempt`, with its provider and model.
 *
 * The chain is an `ExecutionPlan` (`effect`, `@stability unstable` in 4.0.2), built for each request,
 * with one step for each target. A step provides its target and its provider's request function
 * (`FallbackStep`), and the attempt run under the plan reads them.
 * - Each step makes one attempt: it has no `attempts` and no `schedule`. The request is retried
 *   within the attempt, before the provider begins to respond (`provider-call.ts`).
 * - Each attempt passes on what its request streams, and notes whether that was a delta with text
 *   or a part. A failed attempt fails with the request's failure and that note (`AttemptFailed`).
 * - The first step has no `while` predicate. Effect does not consult the first step's `while` when
 *   the step has no `attempts`.
 * - Step `i`'s `while` receives the error of step `i - 1`'s attempt, and decides whether step `i`
 *   runs. It moves on after a failure in `fallsBackOn` from an attempt that passed nothing on, and
 *   before it does, it records the failed attempt and logs the fallback. Effect consults it once, so
 *   each failure is recorded once.
 * - When step `i`'s `while` refuses an error, Effect gives the same error to each later step's
 *   `while`, which refuses it too, so the request fails with the error that was refused. Every step
 *   uses the same rule for this reason: a step with a different rule could be skipped, and the step
 *   after it would attribute the earlier step's error to the skipped target.
 * - The attempt reads its step from the plan's metadata (`ExecutionPlan.CurrentMetadata`), which
 *   Effect provides to the attempt but not to `while`. An attempt on a step after the first records
 *   its request (`ModelRequestDispatched`) and, when it answers, the change of model.
 *
 * The plan's `onEvent` observer is not used to record attempts: an `AttemptFailure` event does not
 * say whether the plan moves on, and Effect ignores the observer's own failures and defects.
 */

import { Array as Arr, Context, Data, Effect, ExecutionPlan, Layer, Ref } from "effect";
import type * as AiError from "effect/ai/AiError";
import { FailureText, type ProviderName, type TurnId } from "../agent-machine/names.ts";
import { ModelClient, type ModelContext, type ProviderRequest, type Target } from "./contracts.ts";
import { logKeys } from "./log-keys.ts";
import { ModelStream } from "./model-stream.ts";
import { failedAs, receivedAiError, type RequestFailed } from "./provider-call.ts";
import { harnessParts } from "./origin.ts";
import { Report } from "./report.ts";
import { sentAs } from "./sent.ts";

/** The `AiError` reasons after which the next provider is tried, when the attempt had passed nothing on. */
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
}

/** The target of a step of the chain's plan, and the request function of the target's provider. */
class FallbackStep extends Context.Service<FallbackStep, { readonly target: Target; readonly request: ProviderRequest }>()(
  "agent-session/FallbackStep",
) {}

/** Returns the request function for `target`'s provider. A provider with no configured request is a configuration fault: a defect, not a failed request. */
const requestFor = (chain: FallbackChain, target: Target): Effect.Effect<ProviderRequest> => {
  const request = chain.requests.get(target.provider);
  return request === undefined
    ? Effect.die(new Error(`No request is configured for provider ${target.provider}`))
    : Effect.succeed(request);
};

const sameTarget = (a: Target, b: Target): boolean => a.provider === b.provider && a.model === b.model;

/** A failed attempt: the request's failure, and whether the attempt had passed on a delta with text or a part. */
class AttemptFailed extends Data.TaggedError("AttemptFailed")<{
  readonly failed: RequestFailed;
  readonly passedOn: boolean;
}> {}

/** One attempt, at the target of the plan's current step. */
const attempt = (context: ModelContext, turn: TurnId) =>
  Effect.gen(function* () {
    const { target, request } = yield* FallbackStep;
    const fellBack = (yield* ExecutionPlan.CurrentMetadata).stepIndex > 0;
    const passOn = yield* ModelStream;
    const passedOn = yield* Ref.make(false);
    const response = yield* Effect.gen(function* () {
      // The loop records the request to the target it chose; a request to a fallback is recorded here.
      if (fellBack)
        yield* (yield* Report)(
          { _tag: "ModelRequestDispatched", turn, provider: target.provider, model: target.model, sent: sentAs(context) },
          harnessParts.fallbackChain,
        );
      return yield* request(target, context, turn).pipe(
        // A delta with no text adds nothing to its part; the loop does not pass it on either.
        Effect.provideService(ModelStream, (streamed) =>
          (streamed._tag === "Part" || (streamed._tag === "Delta" && streamed.text !== "") ? Ref.set(passedOn, true) : Effect.void).pipe(
            Effect.andThen(passOn(streamed)),
          ),
        ),
      );
    }).pipe(
      Effect.withSpan("agent.model.attempt", { attributes: { provider: target.provider, model: target.model } }),
      Effect.catch((failed) => Effect.flatMap(Ref.get(passedOn), (noted) => Effect.fail(new AttemptFailed({ failed, passedOn: noted })))),
    );
    if (fellBack) yield* (yield* Report)({ _tag: "ModelChangeArrived", provider: target.provider, model: target.model }, harnessParts.fallbackChain);
    return response;
  });

/** The `while` predicate of the step that sends the request to `to`, after the attempt at `from` failed. */
const movesOn =
  (from: Target, to: Target, turn: TurnId) =>
  ({ failed: { error, request }, passedOn }: AttemptFailed): Effect.Effect<boolean> =>
    !passedOn && fallsBackOn.has(error.reason._tag)
      ? Effect.gen(function* () {
          yield* (yield* Report)(
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
          return true;
        })
      : Effect.succeed(false);

/** The plan for one request: a step for each of `targets`, in order. */
const planFor = (chain: FallbackChain, targets: readonly [Target, ...ReadonlyArray<Target>], turn: TurnId) =>
  Effect.gen(function* () {
    const [chosen, ...fallbacks] = targets;
    const first = { provide: Context.make(FallbackStep, { target: chosen, request: yield* requestFor(chain, chosen) }) };
    // Each fallback, paired with the target before it.
    const rest = yield* Effect.forEach(Arr.zip(targets, fallbacks), ([from, target]) =>
      requestFor(chain, target).pipe(
        Effect.map((request) => ({ provide: Context.make(FallbackStep, { target, request }), while: movesOn(from, target, turn) })),
      ),
    );
    return ExecutionPlan.make(first, ...rest);
  });

/** The model client over `chain`. The fallbacks' providers are checked when the layer is built; the chosen target's provider is checked per request. */
export const FallbackModelClient = (chain: FallbackChain) =>
  Layer.effect(
    ModelClient,
    Effect.forEach(chain.fallbacks, (target) => requestFor(chain, target)).pipe(
      Effect.as(
        ModelClient.of({
          respond: (target, context, turn) =>
            planFor(chain, [target, ...chain.fallbacks.filter((fallback) => !sameTarget(fallback, target))], turn).pipe(
              Effect.flatMap((plan) => Effect.withExecutionPlan(attempt(context, turn), plan)),
              Effect.catch(({ failed }) => failedAs(turn)(failed)),
            ),
        }),
      ),
    ),
  );
