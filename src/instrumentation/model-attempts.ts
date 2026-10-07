/**
 * How each attempt at a model request ended, on the attempt's span (`agent.model.attempt`,
 * `agent-session/model-fallback.ts`).
 *
 * `observedAttempts` wraps one provider's request function, and runs inside the attempt's span:
 *
 * - An attempt that responded has `outcome` `responded`, `ending` (the response's ending, classified),
 *   `stop` (the provider's reason, when it gave one), `output_tokens` (when the response reported its
 *   usage) and `tokens_per_second` (`tokensPerSecond`). The response as the adapter assembled it is
 *   written to a capture file (`response_message`, `http-captures.ts`), encoded as the observation
 *   it is recorded as.
 * - An attempt that failed has `outcome` `failed`, `failure` (the error's text), `error_kind` (the
 *   `AiError`'s reason) and `error_signature` (`error-signature.ts`), and `http_status` when its last
 *   HTTP response was not 2xx (`FailedStatus`, kept by `agent-session/provider-call.ts`). A status
 *   that a retry within the attempt got past is not put on the span.
 *
 * The time to the first token (`ttft_ms`) is put on the attempt's span by `TimedModelClient`
 * (`model-timing.ts`), as the response streams. The attempt that answered passes its time to the
 * first token and its tokens per second to the request's span through `AnsweringAttempt`.
 */

import { Clock, Context, Effect, Option, Ref, Schema } from "effect";
import { Observation } from "../agent-machine/observation.ts";
import type { ProviderRequest } from "../agent-session/contracts.ts";
import { FailedStatus } from "../agent-session/provider-call.ts";
import { errorSignature } from "./error-signature.ts";
import { captureBody } from "./http-captures.ts";

/** The attempt that answered a request: the milliseconds to its first token, and its output tokens per second, each when known. */
export interface AnsweredIn {
  readonly ttftMs?: number;
  readonly tokensPerSecond?: number;
}

/** Where the attempt that answers a request puts its timing; `TimedModelClient` gives each request its own, and none is kept outside one. */
export const AnsweringAttempt = Context.Reference<Ref.Ref<AnsweredIn | undefined> | undefined>("instrumentation/AnsweringAttempt", { defaultValue: () => undefined });

/**
 * Returns an attempt's output tokens per second after its first token: `outputTokens` divided by the
 * seconds from the first token (`ttftMs` after the attempt's start) to `elapsedMs` after it. Undefined
 * when the first token's time is not known, or when no time passed after it.
 */
export const tokensPerSecond = (outputTokens: number, elapsedMs: number, ttftMs: number | undefined): number | undefined => {
  if (ttftMs === undefined || elapsedMs <= ttftMs) return undefined;
  return outputTokens / ((elapsedMs - ttftMs) / 1000);
};

/** The span attributes of a failure: its text, the kind of error when it is known, and the text's signature. */
export const failureAttributes = (failure: string, kind: string | undefined): Readonly<Record<string, string>> => ({
  failure,
  ...(kind === undefined ? {} : { error_kind: kind }),
  error_signature: errorSignature(failure),
});

const encodeObservation = Schema.encodeSync(Schema.fromJsonString(Observation));

/** `request`, with how each attempt ended put on its span (see the module's description). */
export const observedAttempts =
  (request: ProviderRequest): ProviderRequest =>
  (target, context, turn) =>
    request(target, context, turn).pipe(
      Effect.tap((response) =>
        Effect.gen(function* () {
          const span = Option.getOrUndefined(yield* Effect.option(Effect.currentSpan));
          const now = yield* Clock.currentTimeNanos;
          const ttft = span?.attributes.get("ttft_ms");
          const ttftMs = typeof ttft === "number" ? ttft : undefined;
          const output = response.usage?.output;
          const rate = output === undefined || span === undefined ? undefined : tokensPerSecond(output, Number(now - span.status.startTime) / 1e6, ttftMs);
          yield* Effect.annotateCurrentSpan({
            outcome: "responded",
            ending: response.ending._tag,
            ...(response.stop === undefined ? {} : { stop: response.stop }),
            ...(output === undefined ? {} : { output_tokens: output }),
            ...(rate === undefined ? {} : { tokens_per_second: rate }),
          });
          const answering = yield* AnsweringAttempt;
          if (answering !== undefined) yield* Ref.set(answering, { ...(ttftMs === undefined ? {} : { ttftMs }), ...(rate === undefined ? {} : { tokensPerSecond: rate }) });
          yield* captureBody("response_message", () => encodeObservation(response));
        }),
      ),
      Effect.tapError(({ error }) =>
        Effect.gen(function* () {
          const kept = yield* FailedStatus;
          const status = kept === undefined ? undefined : yield* Ref.get(kept);
          yield* Effect.annotateCurrentSpan({ outcome: "failed", ...failureAttributes(error.message, error.reason._tag), ...(status === undefined ? {} : { http_status: status }) });
        }),
      ),
      // Each attempt keeps its own last status.
      Effect.provideServiceEffect(FailedStatus, Ref.make<number | undefined>(undefined)),
    );
