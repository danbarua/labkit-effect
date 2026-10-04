/**
 * Every event the process groups log. The key is the event's name in the log:
 * `<area>.<subject>.<what happened>`.
 */

export const logKeys = {
  process: {
    /** A process group's state changed: its name, its command, what happened, and the state before and after. */
    changed: "process.group.changed",
    /** A run's environment: the names of this process's variables left out, as credentials, and of those the command sets. Never their values. */
    environment: "process.group.environment",
  },
} as const;
