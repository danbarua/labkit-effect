/**
 * Every event the ACP host logs, by the area that logs it. The key is the event's name in the log:
 * `<area>.<subject>.<what happened>`. The ids an event is about ride as log annotations: `connection`
 * (minted per connection), `request` (the JSON-RPC id, set by the peer), `session`, `turn` and
 * `call`; the details say the rest.
 */

export const logKeys = {
  session: {
    /** `session/new` made a draft: its working folder, the model it starts with and the tools its world gave. */
    created: "acp_host.session.created",
    /** `session/new` was refused: why (a working folder that is not absolute, no model to ask). */
    refused: "acp_host.session.refused",
    /** The first prompt opened the draft (turn zero): the session's facts are now kept in its folder. */
    opened: "acp_host.session.opened",
    /** The draft could not be opened: what failed, and the cause. The session stays a draft. */
    notOpened: "acp_host.session.not_opened",
    /** `session/close` closed the session. */
    closed: "acp_host.session.closed",
    /** A request named a session this connection does not hold. */
    unknown: "acp_host.session.unknown",
  },
  config: {
    /** `session/set_config_option` changed the configuration: of the draft, or from the next turn. */
    changed: "acp_host.config.changed",
    /** `session/set_config_option` was refused: why. */
    refused: "acp_host.config.refused",
    /** `LABKIT_ACP_PERMISSION_MODE` names no permission mode: its value, and the mode used instead. */
    permissionModeUnknown: "acp_host.config.permission_mode_unknown",
  },
  prompt: {
    /** `session/prompt` arrived: the blocks it carries. */
    received: "acp_host.prompt.received",
    /** A prompt was refused before it ran: one runs already. */
    refused: "acp_host.prompt.refused",
    /** The prompt was given to the session. */
    admitted: "acp_host.prompt.admitted",
    /** The prompt was answered: its stop reason, or the error, and how long it took. */
    settled: "acp_host.prompt.settled",
    /** The prompt could not be run: what failed, and the cause. */
    failed: "acp_host.prompt.failed",
    /** The prompt request was interrupted: by the client (the turn is cancelled), or by the end of the connection (the turn is left running). */
    interrupted: "acp_host.prompt.interrupted",
  },
  cancel: {
    /** `session/cancel` (or an interrupted prompt) asked the turn under way to stop. */
    requested: "acp_host.cancel.requested",
  },
  permission: {
    /** A call's permission was asked of the client. */
    asked: "acp_host.permission.asked",
    /** The client answered: the option it picked, or `cancelled`. */
    answered: "acp_host.permission.answered",
    /** Asking failed (the client's error, a closed connection, an answer no option fits): the call is refused once. */
    failed: "acp_host.permission.failed",
  },
  export: {
    /** `/export` wrote the transcript: where. */
    written: "acp_host.export.written",
    /** `/export` could not write the transcript: where, and the cause. */
    failed: "acp_host.export.failed",
  },
  usage: {
    /** The `usage_update` sent at a turn's end. */
    sent: "acp_host.usage.sent",
  },
  update: {
    /** A `session/update` could not be sent: its kind, and the cause. */
    notSent: "acp_host.update.not_sent",
  },
} as const;
