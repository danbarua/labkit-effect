/**
 * Every event the process groups log. The key is the event's name in the log:
 * `<area>.<subject>.<what happened>`.
 */

export const logKeys = {
  process: {
    /** A process group's state changed: its name, its command, what happened, and the state before and after. */
    changed: "process.group.changed",
  },
} as const;
