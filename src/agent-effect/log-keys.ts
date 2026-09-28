/**
 * Every event agent-effect logs, by the area that logs it. The key is the event's name in the log:
 * `<area>.<subject>.<what happened>`.
 */

export const logKeys = {
  anthropic: {
    /** The request carried the default `max_tokens`, because the context set no output limit. */
    maxTokensSupplied: "anthropic.request.max_tokens_supplied",
    /** A stored tool input was not a JSON object, so `{}` was sent in its place. */
    toolInputReplaced: "anthropic.request.tool_input_replaced",
    /** A request did not produce a usable response; the details are what was received. */
    requestFailed: "anthropic.request.failed",
  },
} as const;
