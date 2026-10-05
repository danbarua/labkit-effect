/** The log events that process groups write. Each key has the form `<area>.<subject>.<event>`. */

export const logKeys = {
  process: {
    /** A process group's state changed. Details: the group's name, the command and its arguments with credential values redacted, the event, and the states before and after. */
    changed: "process.group.changed",
    /** A run's environment. Details: the names of the credential variables removed from the inherited environment (`removed`) and of the variables that the command sets (`set`). Values are never logged. */
    environment: "process.group.environment",
    /** Warning: a run ended, and the spawner reported neither an exit code nor a signal. Details: the group's name, the run, and the error. The run's state is Exited with neither. */
    exitUnread: "process.run.exit_unread",
  },
} as const;
