/** The log events that process groups write. Each key has the form `<area>.<subject>.<event>`. */

export const logKeys = {
  process: {
    /** A process group's state changed. Details: the group's name, the command and its arguments with credential values redacted, the event, and the states before and after. */
    changed: "process.group.changed",
    /**
     * A run's environment. Details: the names of this process's variables that the session's environment does not have (`removed`;
     * by default, the credential variables), and of the variables that the command sets (`set`). Values are never logged.
     */
    environment: "process.group.environment",
    /** Warning: a run ended, and the spawner reported neither an exit code nor a signal. Details: the group's name, the run, and the error. The run's state is Exited with neither. */
    exitUnread: "process.run.exit_unread",
  },
  session: {
    /** A closing session sent SIGTERM to a process group that one of its commands started. Details: the session, the group, and the call that started it. */
    groupTerminated: "process.session.group_terminated",
    /**
     * Warning: a process group still existed `stopGrace` after the closing session sent it SIGTERM, and the session sent it SIGKILL.
     * Details: the session, the group, the call that started it, and the grace.
     */
    groupKilled: "process.session.group_killed",
    /** Debug: a process group that one of the session's commands started had ended before the session stopped it. Details: the session, the group, and the call. */
    groupEnded: "process.session.group_ended",
    /**
     * Warning: a signal to a process group failed for a reason other than the group having ended, such as a lack of permission.
     * Details: the session, the group, the call, the signal, and the error.
     */
    signalFailed: "process.session.signal_failed",
  },
} as const;
