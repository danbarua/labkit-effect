/**
 * Every event agent-effect logs, by the area that logs it. The key is the event's name in the log:
 * `<area>.<subject>.<what happened>`.
 */

export const logKeys = {
  provider: {
    /** A model request failed for a reason that is retryable, and is tried again. */
    requestRetried: "provider.request.retried",
    /** A model request failed and will not be tried again; the details are the whole error. */
    requestFailed: "provider.request.failed",
    /** A stored tool input was not a JSON object, so `{}` was sent in its place. */
    toolInputReplaced: "provider.request.tool_input_replaced",
  },
  loop: {
    /** A turn-end hook's feedback held a turn open. */
    turnHeld: "loop.turn_end.held",
    /** A turn reached `maxHolds`; its turn-end hooks were not run again. */
    holdsExhausted: "loop.turn_end.holds_exhausted",
  },
  anthropic: {
    /** The request carried the default `max_tokens`, because the context set no output limit. */
    maxTokensSupplied: "anthropic.request.max_tokens_supplied",
  },
} as const;
