/**
 * Every event the MCP client logs, by the area that logs it. The key is the event's name in the log:
 * `<area>.<subject>.<what happened>`.
 */

export const logKeys = {
  peer: {
    /** A notification was dropped: no handler serves its method, or its params failed to decode. */
    notificationDropped: "mcp.peer.notification_dropped",
    /** A notification's handler failed or died; there is no one to answer. */
    notificationFailed: "mcp.peer.notification_failed",
    /** A request's handler failed with something other than a JSON-RPC error, or died; the request was answered -32603. */
    handlerFailed: "mcp.peer.handler_failed",
    /** A response arrived whose id matches no pending call, and was ignored. */
    responseIgnored: "mcp.peer.response_ignored",
    /** A message could not be written to the server; the details say why. */
    notWritten: "mcp.peer.not_written",
    /** The connection to the server could not be read; the details say why. */
    notRead: "mcp.peer.not_read",
  },
  server: {
    /** A server's state changed: what happened, the state before and after, its run, what it says, and its tools once ready. */
    changed: "mcp.server.changed",
    /** The server answered `initialize`: the version offered and the one it answered, and what it says of itself. */
    initialized: "mcp.server.initialized",
    /** The server wrote a line to stderr. */
    stderr: "mcp.server.stderr",
    /** The server logged a message (`notifications/message`): its level, logger and data. */
    logged: "mcp.server.logged",
    /** The server reported progress (`notifications/progress`). */
    progress: "mcp.server.progress",
    /** The server said its tool list changed (`notifications/tools/list_changed`). */
    toolsChanged: "mcp.server.tools_changed",
    /** A server's tool is not offered: its name, once made one providers take, is too long or the same as another's. */
    toolLeftOut: "mcp.server.tool_left_out",
    /** `/mcp reconnect` started a server again: its name, and its state once settled. */
    reconnected: "mcp.server.reconnected",
    /** The server's input closed: nothing more can be sent to it. */
    stdinClosed: "mcp.server.stdin_closed",
    /** A remote server no longer had the session: a new one was made, and the request it refused is made again once. */
    sessionRenewed: "mcp.server.session_renewed",
    /** A remote server's connection ended between requests: a new one is made. */
    connectionLost: "mcp.server.connection_lost",
  },
  http: {
    /** The endpoint refused a message, or was not reached: the methods it carried, the status, what the server said, and whether the session had ended. */
    refused: "mcp.http.refused",
    /** The server gave a session (`Mcp-Session-Id`), in answer to `initialize`. */
    session: "mcp.http.session",
    /** The server offers no GET stream (`405`): what it sends unasked comes only with answers. */
    noStream: "mcp.http.no_stream",
    /** The server refused the GET stream: the status, and what it said. */
    streamRefused: "mcp.http.stream_refused",
    /** The server's stream ended. */
    streamEnded: "mcp.http.stream_ended",
    /** The server's stream could not be read on: why. */
    streamBroke: "mcp.http.stream_broke",
  },
} as const;
