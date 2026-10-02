/**
 * Every event acp logs, by the area that logs it. The key is the event's name in the log:
 * `<area>.<subject>.<what happened>`.
 */

export const logKeys = {
  initialize: {
    /** `initialize` was answered: the details name the side, the version offered and the version chosen. */
    negotiated: "acp.initialize.negotiated",
  },
  gate: {
    /** A request or notification from the other end needed a capability that was not advertised; it was answered with an error, or dropped. */
    refusedIncoming: "acp.gate.refused_incoming",
    /** A request or notification this end was about to send needed a capability the other end did not advertise; nothing was sent. */
    refusedLocally: "acp.gate.refused_locally",
  },
} as const;
