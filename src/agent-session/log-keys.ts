/** The log events that agent-session writes, by area. Each key has the form `<area>.<subject>.<event>`. */

export const logKeys = {
  tools: {
    /** A tool call's input had properties its tool does not take; the call ran without them (strict input off). */
    inputIgnored: "tool.input.ignored",
    /** The git tools' repository could not be opened to say whether it is a linked worktree; the system text calls it a repository. */
    repositoryNotOpened: "tool.git.repository_not_opened",
  },
  blobs: {
    /** A blob's file holds bytes whose hash is not its id; the store finds nothing for it. */
    notAsStored: "blobs.file.not_as_stored",
  },
  sessionStore: {
    /**
     * The file-backed store opened a session file whose lock names a process that is not running,
     * or names no process, and took the lock over. The details include the lock file's text (`contents`).
     */
    lockTakenOver: "session_store.lock_taken_over",
    /** The file-backed store could not flush the session file's folder to the disk after creating the file; the details carry the error. */
    folderNotFlushed: "session_store.folder_not_flushed",
    /** The session file's last line was not a whole fact (its write did not finish); the store cut it off before writing. */
    tornLineCut: "session_store.torn_line_cut",
  },
  provider: {
    /** A model request failed for a reason that is retryable, and is tried again; the details include the whole error. */
    requestRetried: "provider.request.retried",
    /** A model request failed for a reason that is retryable, and is not tried again; the details say why, and include the whole error. */
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
    partsOmitted: "provider.request.parts_omitted",
    fileAsPointer: "provider.request.file_as_pointer",
    /** A field of the request's context that this provider's adapter does not translate was not sent; the details name the field, its value, and what the provider does without it. */
    notTranslated: "provider.request.not_translated",
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
    /** A model request policy vetoed a turn's request, which ends the turn; the details are the turn, the policy by its name, and the reason. */
    modelVetoed: "loop.model.vetoed",
    /** A tool call policy vetoed a call, which does not run; the details are the call, its tool, the policy by its name, and the reason. */
    toolVetoed: "loop.tool.vetoed",
    /** A model request policy held a turn's request, which fails the turn; the details are the turn and what the user is told. */
    modelHeld: "loop.model.held",
    /** Carrying out a request died of a defect; the details are the request, the defect's name and message (`defect`), and its stack (`stack`). */
    requestDied: "loop.request.died",
    /** A turn-end hook's feedback held a turn open. */
    turnHeld: "loop.turn_end.held",
    /** A turn's hooks gave feedback after it had been held `maxHolds` times; the feedback was not given to it. */
    holdsExhausted: "loop.turn_end.holds_exhausted",
    /** The turn was interrupted while its turn-end hooks ran: the hooks were stopped, and any feedback they had was not given to it. */
    reviewStopped: "loop.turn_end.stopped",
  },
  anthropic: {
    /** The request carried the default `max_tokens`, because the session's settings gave no output limit. */
    maxTokensSupplied: "anthropic.request.max_tokens_supplied",
    /** A stream's delta was of a type the adapter does not know; the block is recorded without it. */
    deltaNotApplied: "anthropic.response.delta_not_applied",
    /**
     * A tool_use block's streamed input was not JSON; the call is recorded with that input as text,
     * which the tool rejects. The details are the call, its tool and the input.
     */
    toolInputUnparsed: "anthropic.response.tool_input_unparsed",
  },
} as const;
