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
  },
  anthropic: {
    /** The request carried the default `max_tokens`, because the context set no output limit. */
    maxTokensSupplied: "anthropic.request.max_tokens_supplied",
    /** A stored tool input was not a JSON object, so `{}` was sent in its place. */
    toolInputReplaced: "anthropic.request.tool_input_replaced",
  },
} as const;
