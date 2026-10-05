# agent-mcp

`src/agent-mcp` is an MCP client. It connects to MCP servers that a session keeps, offers their
tools to the session as tool sources, and tells the model when a server stops or runs again. A
server is reached in one of three ways:

| Transport | How |
| --- | --- |
| stdio | A child process (`agent-process`), with newline-delimited JSON-RPC on its stdin and stdout. |
| Streamable HTTP (`http`) | A POST to the server's URL for each message, plus an optional GET stream. |
| HTTP+SSE (`sse`, protocol 2024-11-05) | A GET stream, and POSTs to the endpoint that the stream names. |

MCP's messages are Effect's (`effect/ai` `McpSchema`). The JSON-RPC peer (`peer.ts`) is a copy of
`effective-acp`'s peer, with MCP's cancellation added. Effect's `RpcClient` was not used because it
drops the messages that a server sends without being asked.

## Files

| File | Responsibility |
| --- | --- |
| `client.ts` | `connectOver(name, wire, roots)`: one connection over any wire (`initialize`, `tools`, `call`). `connectStdio` starts a process and connects over its pipes; only tests use it. |
| `http.ts` | The wire to a server at a URL (`remoteWire`), and `connectRemote`. |
| `peer.ts` | One JSON-RPC connection that both serves requests and makes them. Listed in `imperativeBoundaries` in `oxlint.config.ts`. |
| `server-machine.ts` | A pure state machine for one server over its runs. |
| `server.ts` | `startMcpServer`: one server that a session keeps, with `reconnect`, `stop` and `call`. |
| `source.ts` | A server's tools as a tool source, under the namespace `mcp__<server>`. |
| `servers.ts` | `startMcpServers`: the servers of one session, their tool sources, their notices, and their state changes. |
| `command.ts` | The `/mcp` command: each server's state, and `/mcp reconnect <server>`. |
| `log-keys.ts` | The names of the log events that this module writes. |

## The client

- **Initialization.** The client offers `initialize` its latest protocol version
  (`protocolVersion`) and the host's brand as `clientInfo` (the default brand when the host gives
  none). It keeps the server's answer, then sends `notifications/initialized`.
- **Tools.** `tools` lists every page, following `nextCursor`.
- **Calls.** A call returns the tool's result as the server sent it, decoded with `McpSchema`. A
  tool's own failure is a result with `isError: true`.
- **Requests from the server.** During a call, the client answers `ping`, and answers `roots/list`
  with the roots it was given.
- **Cancellation.** A call interrupted after its request was written sends
  `notifications/cancelled` with the request id, and the late answer is dropped.
- **Failures.** A request that the server answers with an error, or that gets no answer because the
  connection ended, fails with `McpFailed`, which names the server and the request.
- **Params.** A message with no params is read as having none. When a message has no params, the
  field is omitted rather than written as `null`, because JSON-RPC does not allow `null` params.

## A server's states

| State | Meaning |
| --- | --- |
| `Stopped` | No run, or the run was stopped. |
| `Connecting` | A run is starting, and the server has not yet answered `initialize` and listed its tools. |
| `Ready` | The server answered and listed its tools. |
| `Failed` | The run could not start, the server did not connect within `connectTimeout`, or it refused the credentials given. The run is stopped. |
| `NeedsAuth` | The server asks for authorization that this client cannot give. The run is stopped. |
| `Exited` | The run ended. |

Each state names the run it is about. An event about an earlier run changes nothing. A stdio
server's run is its process; a remote server's run is its connection.

- A call is made on the run that is ready. While no run is ready, a call fails with `McpFailed`,
  naming the server's state.
- `reconnect` ends the current run (for a remote server, it ends the session) and starts a new one.
- `connectTimeout` is 30 seconds unless the host gives another. A server that does not answer
  `initialize` and list its tools in time has failed, and its run is stopped, so nothing is left
  running.

### Remote servers

- **Session lost.** When a server no longer has the session (a 404 to a request that carried it),
  the client makes a new session (`initialize` again) and makes the refused request again, once. The
  renewal is logged as a warning (`mcp.server.session_renewed`).
- **Stream lost.** When an HTTP+SSE server's stream ends between requests, the client connects anew,
  and logs a warning (`mcp.server.connection_lost`).
- **Answer lost.** A request whose response stream ended before its answer fails and is not made
  again, because whether it ran is not known.
- When a new connection cannot be made, the run has ended.
- **Credentials.** A server that answers 401 or 403, while connecting or to a request once ready:
  - needs authorization (`NeedsAuth`) when its headers give no credentials (no `Authorization`
    header, and no header whose name is a credential name, such as `X-API-Key`). The reason says
    whether the server asks for OAuth (a `WWW-Authenticate` that names OAuth's metadata), which this
    client does not support;
  - has failed when credentials were given: they were refused.

### Transports

- **Streamable HTTP.** Each message is a POST to the server's URL, accepting JSON and SSE. The
  server answers 202 (for a notification or a response), one JSON message, or an SSE stream (its
  own requests during the request, then the answer). An SSE event with no data carries no message.
  After `initialize`, each message carries the session (`Mcp-Session-Id`) and the agreed version
  (`MCP-Protocol-Version`). A GET stream with both headers carries what the server sends without
  being asked, unless the server answers 405; the client reopens the stream one second after it
  ends. When the connection's scope closes, the client ends the session with a DELETE.
- **HTTP+SSE.** A GET stream to the server's URL. Each message is posted to the URL that the
  stream's `endpoint` event gives; every message from the server arrives on the stream, and the
  connection ends with the stream. A 404 from the endpoint means the session ended, because the
  endpoint's URL carries the session.
- **Refusals.** A request that the endpoint refuses fails with what HTTP returned (`rejectionOf`):
  the status, `WWW-Authenticate`, the start of the body, and whether the session had ended. A
  server that cannot be reached is status 0.
- **Logging.** The configured headers go with every request and are never logged. URLs are logged
  without their query (`whereOf`), which may hold a credential.

## Tools as a tool source

- **Names.** A server's tools are offered as `mcp__<server>__<tool>`. Every character of the
  server's or the tool's name that providers do not accept in a tool name (anything other than
  letters, digits, `_` and `-`) is replaced by `_`. A tool whose offered name is then longer than 64
  characters, or the same as another tool's, is not offered; the omission is logged as a warning
  with the reason.
- **Kinds.**

  | The server says | Kind | Replay |
  | --- | --- | --- |
  | `readOnlyHint` | `read` | `safe` |
  | `idempotentHint` | `other` | `idempotent` |
  | neither | `other` | `unsafe` |

- **Calls.** A call's input must be a JSON object; any other input ends `InputRejected`. The result
  is recorded as the server sent it (`mcpToolResult`). A result with `isError: true` ends `Reported`.
  A call that the server does not answer ends `Reported`, with the reason.

## A session's servers

- `startMcpServers` starts all of a session's servers at once, in the session's scope. Once all have
  settled, the tools of the ready servers become tool sources, in the order the servers were given.
  A session's tools are fixed when it opens, so a server that becomes ready later offers no tools
  in that session.
- **Notices.** The model is told once of each server that is not running when it is first asked,
  and of each server that stops later, and once more when a server runs again. A server that is
  ready when the session starts is not mentioned.
- **Changes.** Each change of a server's state is recorded as `McpServerChanged`, starting from the
  state the server is in when recording starts. A server that is still connecting is not recorded.
  A ready server's change lists its tools by their offered names.
- `reconnect` starts a server again and returns its state once it has settled.

## Not built

These items are in `TODO.md`:

- OAuth. A server that asks for it needs authorization; a token can be given in its headers.
- Resuming a Streamable HTTP stream that broke off (`Last-Event-ID`).
- Sampling and elicitation: the client does not offer them, so a server does not ask.
- Acting on `notifications/tools/list_changed`: it is logged. Tools that a reconnected server lists
  for the first time are logged too, and not offered.

## Tests

- `client.test.ts`: the client over stdio.
- `http.test.ts`: the HTTP transports, session renewal and credentials.
- `server.test.ts`: the state machine and server runs.
- `source.test.ts`: tool names, kinds and calls.
- `servers.test.ts`: a session's servers, notices and changes.
