/**
 * Every event agent-host logs, by the area that logs it. The key is the event's name in the log.
 */

export const logKeys = {
  localServer: {
    /** The local server's model list could not be read; the details carry its URL and the error. No local models are listed. */
    modelsNotListed: "host.local_models.not_listed",
  },
  record: {
    /** A session's record file could not be read; the details carry the session, the file and the cause. The session is listed without it. */
    unreadable: "host_record.unreadable",
  },
  logs: {
    /**
     * When the host's logs are made: the credential variables whose values are too short to be
     * looked for in log lines; the details carry each variable's name and its value's length,
     * never the value, and the shortest length looked for.
     */
    secretsNotLookedFor: "host_logs.secrets_not_looked_for",
  },
} as const;
