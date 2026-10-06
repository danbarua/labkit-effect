/**
 * Every event the CLI logs, by the area that logs it. The key is the event's name in the log.
 */

export const logKeys = {
  settings: {
    /** The session's effective-settings.json was written; the details carry its path. */
    written: "cli.settings.written",
    /** The session's effective-settings.json could not be written; the details carry the folder and the cause. The session continues. */
    notWritten: "cli.settings.not_written",
  },
  mcp: {
    /** A change in an MCP server's state could not be recorded; the details carry the server, its state and the cause. */
    notRecorded: "cli.mcp.not_recorded",
  },
  follow: {
    /** The REPL failed to handle one session update (a terminal write threw); the details carry the update's kind and the cause. Following continues. */
    inputFailed: "cli.follow.input_failed",
  },
} as const;
