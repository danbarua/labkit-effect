/** The log events that agent-host writes, by area. Each value is the event's name in the log. */

export const logKeys = {
  localServer: {
    /** Warning: the local server's model list could not be read. Details: its URL and the error. No local models are known. */
    modelsNotListed: "host.local_models.not_listed",
  },
  record: {
    /** Warning: a session's record file could not be read. Details: the session, the file and the cause. The session is listed without its record. */
    unreadable: "host_record.unreadable",
  },
  logs: {
    /**
     * Warning, when the host's logs are created: the credential variables whose values are too short
     * to search for in log lines. Details: each variable's name and its value's length, never the
     * value, and the shortest length that is searched for.
     */
    secretsNotLookedFor: "host_logs.secrets_not_looked_for",
  },
} as const;
