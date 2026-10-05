/**
 * Every event the CLI logs, by the area that logs it. The key is the event's name in the log.
 */

export const logKeys = {
  settings: {
    /** The session's effective-settings.json was written; the details carry its path. */
    written: "cli.settings.written",
    /** The session's effective-settings.json could not be written; the details carry the folder and the cause. The session goes on. */
    notWritten: "cli.settings.not_written",
  },
  session: {
    /** The user stopped the CLI (Ctrl+C) while a turn ran, and the turn's interruption could not be recorded; the details carry the error's message. */
    notInterrupted: "cli.session.not_interrupted",
  },
  mcp: {
    /** A change of an MCP server's state could not be recorded; the details carry the server, its state and the cause. */
    notRecorded: "cli.mcp.not_recorded",
  },
  follow: {
    /** The REPL's follower could not take one input (a write to the terminal threw); the details carry the input's kind and the cause. It goes on with the next. */
    inputFailed: "cli.follow.input_failed",
  },
} as const;
