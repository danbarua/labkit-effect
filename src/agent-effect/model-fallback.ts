/**
 * A model client that tries providers in order: the target the loop chose, then each fallback.
 * It moves to the next only after a failure that means the provider cannot serve the request now
 * (`fallsBackOn`), which reaches it after the adapter's own retries. Any other failure is a fault in
 * the request or the configuration (credentials, an invalid request, content policy, output the
 * adapter could not read); moving to another provider would hide it, so it fails the request as it
 * would with one provider. Each failure the chain moves on from is recorded as it happens
 * (`ModelAttemptFailed`, through `Report`) and logged; when the last target fails too, its failure
 * is the request's outcome, `ModelFailed`.
 *
 * Each attempt runs in a span, `agent.model.attempt`, with its provider and model.
 */

import { Effect, Layer } from "effect";
import type * as AiError from "effect/ai/AiError";
import { FailureText, type ProviderName, type TurnId } from "../agent-core/names.ts";
import { ModelClient, type ModelContext, type ProviderRequest, type Target } from "./contracts.ts";
import { logKeys } from "./log-keys.ts";
import { failedAs, receivedAiError } from "./provider-call.ts";
import { Report } from "./report.ts";

/** The `AiError` reasons after which the next provider is tried. */
export const fallsBackOn: ReadonlySet<AiError.AiErrorReason["_tag"]> = new Set([
  "NetworkError",
  "RateLimitError",
  "QuotaExhaustedError",
  "InternalProviderError",
]);

export interface FallbackChain {
  /** The request each provider is reached through. */
  readonly requests: ReadonlyMap<ProviderName, ProviderRequest>;
  /** Where a request goes, in order, after the target the loop chose. */
  readonly fallbacks: ReadonlyArray<Target>;
}

/** A target whose provider has no request is a configuration fault: a defect, not a failed request. */
const requestFor = (chain: FallbackChain, target: Target): Effect.Effect<ProviderRequest> => {
  const request = chain.requests.get(target.provider);
  return request === undefined
    ? Effect.die(new Error(`No request is configured for provider ${target.provider}`))
    : Effect.succeed(request);
};

const attempt = (
  chain: FallbackChain,
  targets: readonly [Target, ...ReadonlyArray<Target>],
  context: ModelContext,
  turn: TurnId,
): ReturnType<ProviderRequest> => {
  const [target, next, ...rest] = targets;
  const tried = requestFor(chain, target).pipe(
    Effect.flatMap((request) => request(target, context, turn)),
    Effect.withSpan("agent.model.attempt", { attributes: { provider: target.provider, model: target.model } }),
  );
  if (next === undefined) return tried;
  return tried.pipe(
    Effect.catchIf(
      (error) => fallsBackOn.has(error.reason._tag),
      (error) =>
        Effect.gen(function* () {
          yield* (yield* Report)({
            _tag: "ModelAttemptFailed",
            turn,
            provider: target.provider,
            model: target.model,
            failure: FailureText.make(error.message),
            error: receivedAiError(error),
          });
          yield* Effect.logWarning(logKeys.provider.fellBack, {
            from: { provider: target.provider, model: target.model },
            to: { provider: next.provider, model: next.model },
            reason: error.reason._tag,
            message: error.message,
          });
          return yield* attempt(chain, [next, ...rest], context, turn);
        }),
    ),
  );
};

/** The fallbacks' providers are checked when the layer is built; the chosen target's, per request. */
export const FallbackModelClient = (chain: FallbackChain) =>
  Layer.effect(
    ModelClient,
    Effect.forEach(chain.fallbacks, (target) => requestFor(chain, target)).pipe(
      Effect.as(
        ModelClient.of({
          respond: (target, context, turn) =>
            attempt(chain, [target, ...chain.fallbacks], context, turn).pipe(Effect.catch(failedAs(turn))),
        }),
      ),
    ),
  );
