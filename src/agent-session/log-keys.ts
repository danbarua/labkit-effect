/**
 * Every event agent-session logs, by the area that logs it. The key is the event's name in the log:
 * `<area>.<subject>.<what happened>`.
 */

export const logKeys = {
  provider: {
    /** A model request failed for a reason that is retryable, and is tried again. */
    requestRetried: "provider.request.retried",
    /** A model request failed and will not be tried again; the details are the whole error. */
    requestFailed: "provider.request.failed",
    /** A provider could not serve a model request, and it goes to the next provider in the chain. */
    fellBack: "provider.request.fell_back",
    /** A stored tool input was not a JSON object, so `{}` was sent in its place. */
    toolInputReplaced: "provider.request.tool_input_replaced",
    /** A response ended while parts of it were still arriving; they are not recorded. The details name them. */
    partCut: "provider.response.part_cut",
    /** A part of an earlier response was not sent; the details say which part and why. */
    partLeftOut: "provider.request.part_left_out",
  },
  loop: {
    /** The core made a decision, and it was recorded; the details are the decision and where. */
    decisionRecorded: "loop.decision.recorded",
    /** A turn-end hook's feedback held a turn open. */
    turnHeld: "loop.turn_end.held",
    /** A turn reached `maxHolds`; its turn-end hooks were not run again. */
    holdsExhausted: "loop.turn_end.holds_exhausted",
  },
  anthropic: {
    /** The request carried the default `max_tokens`, because the session's settings gave no output limit. */
    maxTokensSupplied: "anthropic.request.max_tokens_supplied",
    /** A stream's delta was of a type the adapter does not know; the block is recorded without it. */
    deltaNotApplied: "anthropic.response.delta_not_applied",
  },
} as const;
