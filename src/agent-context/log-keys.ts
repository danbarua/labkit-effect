/** The log events that agent-context writes. Each key has the form `<area>.<subject>.<event>`. */

export const logKeys = {
  selection: {
    /** A selector moved the request to a model with a larger context window. Details: the models and context windows before and after, and the estimated tokens. */
    modelUpgraded: "context.selection.model_upgraded",
  },
} as const;
