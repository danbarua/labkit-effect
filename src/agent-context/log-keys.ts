/**
 * Every event agent-context logs, by the area that logs it: `<area>.<subject>.<what happened>`.
 */

export const logKeys = {
  selection: {
    /** A selector moved the request to a model with a larger context window. */
    modelUpgraded: "context.selection.model_upgraded",
  },
} as const;
