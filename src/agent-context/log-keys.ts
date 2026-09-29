/**
 * Every event agent-context logs, by the area that logs it: `<area>.<subject>.<what happened>`.
 */

export const logKeys = {
  assembly: {
    /** Notices were assembled, and the model context has no place to send them. */
    noticesNotSent: "context.assembly.notices_not_sent",
  },
  selection: {
    /** A selector moved the request to a model with a larger context window. */
    modelUpgraded: "context.selection.model_upgraded",
  },
} as const;
