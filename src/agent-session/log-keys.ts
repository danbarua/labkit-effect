/**
 * Every event agent-session logs, by the area that logs it. The key is the event's name in the log:
 * `<area>.<subject>.<what happened>`.
 */

export const logKeys = {
  blobs: {
    /** A blob's file holds bytes whose hash is not its id; the store finds nothing for it. */
    notAsStored: "blobs.file.not_as_stored",
  },
  provider: {
    /** A model request failed for a reason that is retryable, and is tried again. */
    requestRetried: "provider.request.retried",
    notRetried: "provider.request.not_retried",
    /** A model request failed and will not be tried again; the details are the whole error. */
    requestFailed: "provider.request.failed",
    /** A provider could not serve a model request, and it goes to the next provider in the chain. */
    fellBack: "provider.request.fell_back",
    /** A stored tool input was not a JSON object, so `{}` was sent in its place. */
    toolInputReplaced: "provider.request.tool_input_replaced",
    /** A response ended while parts of it were still arriving; they are not recorded. The details name them. */
    partCut: "provider.response.part_cut",
    /** A part of an earlier response was not sent; the details say which part and why. */
    partLeftOut: "provider.request.parts_left_out",
    fileAsPointer: "provider.request.file_as_pointer",
  },
  loop: {
    /**
     * An observation was recorded; the details are its kind, its position, its origin, and its
     * fields in brief (its text, numbers and the kind of its outcome or ending).
     */
    observationRecorded: "loop.observation.recorded",
    /** The core made a decision, and it was recorded; the details are the decision and where. */
    decisionRecorded: "loop.decision.recorded",
    /** Writing the session's facts down failed; the details say why, and which facts. The session stops. */
    storeFailed: "loop.store.failed",
    /** A tool call ended; the details are the call, the tool, its input, and how it ended. */
    toolEnded: "loop.tool.ended",
    /** Carrying out a request died of a defect; the details are what it died of. */
    requestDied: "loop.request.died",
    /** A turn-end hook's feedback held a turn open. */
    turnHeld: "loop.turn_end.held",
    /** A turn's hooks gave feedback after it had been held `maxHolds` times; the feedback was not given to it. */
    holdsExhausted: "loop.turn_end.holds_exhausted",
  },
  anthropic: {
    /** The request carried the default `max_tokens`, because the session's settings gave no output limit. */
    maxTokensSupplied: "anthropic.request.max_tokens_supplied",
    /** A stream's delta was of a type the adapter does not know; the block is recorded without it. */
    deltaNotApplied: "anthropic.response.delta_not_applied",
  },
} as const;
