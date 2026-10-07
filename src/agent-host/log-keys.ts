/** The log events that agent-host writes, by area. Each value is the event's name in the log. */

export const logKeys = {
  localServer: {
    /** Warning: the local server's model list could not be read. Details: its URL and the error. No local models are known. */
    modelsNotListed: "host.local_models.not_listed",
    /** Warning: the local server lists a reasoning level that the core does not name. Details: the model, the level, and the efforts the core names. The model is not offered that level. */
    levelNotNamed: "host.local_models.level_not_named",
  },
  record: {
    /** Warning: a session's record file could not be read. Details: the session, the file and the cause. The session is listed without its record. */
    unreadable: "host_record.unreadable",
    /** Warning: a new saved session's record could not be written. Details: the session's folder and the cause. The session runs; listing by host and folder does not find it. */
    notWritten: "host_record.not_written",
  },
  session: {
    /** Error: the interruption of a turn could not be recorded when the run was stopped. Details: the store's message. */
    notInterrupted: "host_session.not_interrupted",
  },
  logs: {
    /**
     * Warning, when the host's logs are created: the credential variables whose values are too short
     * to search for in log lines. Details: each variable's name and its value's length, never the
     * value, and the shortest length that is searched for.
     */
    secretsNotLookedFor: "host_logs.secrets_not_looked_for",
    /**
     * Warning, when the host's logs are created: a log-level variable is set to a value that names no
     * level (`log-level.ts`). Details: the variable, its value, and the level used instead.
     */
    levelInvalid: "host_logs.level_invalid",
  },
} as const;
