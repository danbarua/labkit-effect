/** The log events that the MCP client writes, by area. Each key has the form `<area>.<subject>.<event>`. */

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
    /** A message could not be written to the server; the details give the reason. */
    notWritten: "mcp.peer.not_written",
    /** The connection to the server could not be read; the details give the reason. */
    notRead: "mcp.peer.not_read",
  },
  server: {
    /** A server's state changed. Details: the event, the states before and after, the run, the state's description, and the tools once ready. */
    changed: "mcp.server.changed",
    /** The server answered `initialize`. Details: the version offered, the version it answered, and its `serverInfo`. */
    initialized: "mcp.server.initialized",
    /** The server wrote a line to stderr. */
    stderr: "mcp.server.stderr",
    /** The server logged a message (`notifications/message`): its level, logger and data. */
    logged: "mcp.server.logged",
    /** The server reported progress (`notifications/progress`). */
    progress: "mcp.server.progress",
    /** The server reported that its tool list changed (`notifications/tools/list_changed`). */
    toolsChanged: "mcp.server.tools_changed",
    /** Warning: a server's tool is not offered, because its offered name is too long or the same as another's. */
    toolOmitted: "mcp.server.tool_omitted",
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
    /** Warning: the endpoint refused a message, or was not reached. Details: the methods it carried, the status, the server's response text, and whether the session had ended. */
    refused: "mcp.http.refused",
    /** The server returned a session id (`Mcp-Session-Id`) in answer to `initialize`. */
    session: "mcp.http.session",
    /** The server offers no GET stream (`405`), so messages it sends unasked arrive only with answers. */
    noStream: "mcp.http.no_stream",
    /** Warning: the server refused the GET stream. Details: the status and the server's response text. */
    streamRefused: "mcp.http.stream_refused",
    /** The server's stream ended. */
    streamEnded: "mcp.http.stream_ended",
    /** Warning: the server's stream could not be read further; the details give the reason. */
    streamBroke: "mcp.http.stream_broke",
    /** Warning: the session could not be ended (DELETE) when the connection closed; the details give the status or the reason. */
    notEnded: "mcp.http.not_ended",
  },
} as const;
