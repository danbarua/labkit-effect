/**
 * A model client that tries providers in order: the target that the loop chose, then each fallback.
 * - It moves to the next target only after a failure that means the provider cannot serve the
 *   request now (`fallsBackOn`), after the adapter's own retries.
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
 */

import { Effect, Layer } from "effect";
import type * as AiError from "effect/ai/AiError";
import { FailureText, type ProviderName, type TurnId } from "../agent-machine/names.ts";
import { ModelClient, type ModelContext, type ProviderRequest, type Target } from "./contracts.ts";
import { logKeys } from "./log-keys.ts";
import { failedAs, receivedAiError } from "./provider-call.ts";
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
}

/** Returns the request function for `target`'s provider. A provider with no configured request is a configuration fault: a defect, not a failed request. */
const requestFor = (chain: FallbackChain, target: Target): Effect.Effect<ProviderRequest> => {
  const request = chain.requests.get(target.provider);
  return request === undefined
    ? Effect.die(new Error(`No request is configured for provider ${target.provider}`))
    : Effect.succeed(request);
};

const sameTarget = (a: Target, b: Target): boolean => a.provider === b.provider && a.model === b.model;

/** Tries `targets` in order. `fellBack` is true when an earlier target has failed and the first of `targets` is a fallback. */
const attempt = (
  chain: FallbackChain,
  targets: readonly [Target, ...ReadonlyArray<Target>],
  context: ModelContext,
  turn: TurnId,
  fellBack: boolean,
): ReturnType<ProviderRequest> => {
  const [target, next, ...rest] = targets;
  // The loop records the request to the target it chose; a request to a fallback is recorded here.
  const dispatched = fellBack
    ? Effect.gen(function* () {
        yield* (yield* Report)(
          { _tag: "ModelRequestDispatched", turn, provider: target.provider, model: target.model, sent: sentAs(context) },
          harnessParts.fallbackChain,
        );
      })
    : Effect.void;
  const tried = requestFor(chain, target).pipe(
    Effect.tap(() => dispatched),
    Effect.flatMap((request) => request(target, context, turn)),
    Effect.withSpan("agent.model.attempt", { attributes: { provider: target.provider, model: target.model } }),
    Effect.tap(() =>
      fellBack
        ? Effect.gen(function* () {
            yield* (yield* Report)(
              { _tag: "ModelChangeArrived", provider: target.provider, model: target.model },
              harnessParts.fallbackChain,
            );
          })
        : Effect.void,
    ),
  );
  if (next === undefined) return tried;
  return tried.pipe(
    Effect.catchIf(
      (failed) => fallsBackOn.has(failed.error.reason._tag),
      ({ error, request }) =>
        Effect.gen(function* () {
          yield* (yield* Report)(
            {
              _tag: "ModelAttemptFailed",
              turn,
              provider: target.provider,
              model: target.model,
              failure: FailureText.make(error.message),
              error: receivedAiError(error),
              request,
            },
            { _tag: "Provider", provider: target.provider },
          );
          yield* Effect.logWarning(logKeys.provider.fellBack, {
            from: { provider: target.provider, model: target.model },
            to: { provider: next.provider, model: next.model },
            reason: error.reason._tag,
            message: error.message,
          });
          return yield* attempt(chain, [next, ...rest], context, turn, true);
        }),
    ),
  );
};

/** The model client over `chain`. The fallbacks' providers are checked when the layer is built; the chosen target's provider is checked per request. */
export const FallbackModelClient = (chain: FallbackChain) =>
  Layer.effect(
    ModelClient,
    Effect.forEach(chain.fallbacks, (target) => requestFor(chain, target)).pipe(
      Effect.as(
        ModelClient.of({
          respond: (target, context, turn) =>
            attempt(
              chain,
              [target, ...chain.fallbacks.filter((fallback) => !sameTarget(fallback, target))],
              context,
              turn,
              false,
            ).pipe(Effect.catch(failedAs(turn))),
        }),
      ),
    ),
  );
