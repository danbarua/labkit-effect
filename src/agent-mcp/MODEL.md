# agent-mcp

An MCP client: one connection to one MCP server, over the server's stdio (a child process,
newline-delimited JSON-RPC) or at its URL (Streamable HTTP, or the HTTP+SSE transport of protocol
2024-11-05). MCP's messages are Effect's (`effect/ai` `McpSchema`); the JSON-RPC
peer is a copy of `effective-acp`'s (`peer.ts`), with MCP's cancellation. Effect's `RpcClient` was
tried first (TODO.md, the MCP servers entry): it drops what a server sends unasked.

## What is built

- `client.ts`: `connectOver(name, wire, roots)` connects over any wire: what the server answered to
  `initialize`, its tools (`tools`), and `call`. `connectStdio(server, roots)` starts the server in
  the scope it is given and connects over its pipes.
- `http.ts`: the wire to a server at a URL (`remoteWire`), and `connectRemote(server, roots)`.
- `peer.ts`: one JSON-RPC connection that serves requests and makes them.
- `server-machine.ts`, `server.ts`: one MCP server a session keeps, over its runs: a stdio server's
  run is its process (`agent-process`), a remote server's a connection to its URL.
  `startMcpServer(server, roots)` starts it in the scope given and connects on each run;
  `reconnect` ends the run and starts another; `call` calls a tool of the run that is ready. A
  server must answer `initialize` and list its tools within `connectTimeout` (30 seconds unless a
  host says).
- `source.ts`: a server's tools as a tool source, under the namespace `mcp__<server>`.
- `servers.ts`: the servers one session keeps, `startMcpServers(given, roots)`: their tool sources,
  the notices that tell the model of a server not running, and their changes as the session
  records them (`McpServerChanged`).

## What is not built

- OAuth: a server that asks for it needs authorization (MS7); a token can be given in its headers.
- Resuming a Streamable HTTP stream that broke off (`Last-Event-ID`): a request whose stream ends
  before its answer fails, saying so.
- Sampling and elicitation: the client does not offer them, so a server does not ask.
- A change of a server's tool list (`notifications/tools/list_changed`) is logged, not acted on;
  so are tools a reconnected server lists that it did not list before.

## Rules

- MC1. The client offers `initialize` its latest version (`protocolVersion`) and calls itself what
  its host says (`clientInfo`: the host's brand; the default brand when it says nothing), and keeps
  what the server answers; then it sends `notifications/initialized`. `tools` lists every page, by
  `nextCursor`. A call gives the tool's result as the server sent it, decoded with `McpSchema`; a
  tool's own failure is a result with `isError`.
- MC2. The client answers the server's requests during a call: `ping`, and `roots/list` with the
  roots it was given.
- MC3. A call interrupted after its request was written is cancelled at the server
  (`notifications/cancelled` with its request id), and its late answer is dropped.
- MC4. A request the server answers with an error, or that gets no answer because the connection
  ended, fails with `McpFailed`, naming the server and the request.
- MC5. A message's params left out are read as none, and none are left out when written, not
  written `null`.
- MS1. A server is `Connecting` while its run starts and it answers `initialize`, then `Ready` with
  the tools it listed. It has `Failed` when its run could not be started, it did not connect or it
  refused the credentials given (its run is then stopped), it `NeedsAuth` when it asks for
  authorization this client cannot give (MS7), and it has `Exited` when its run ended. A stdio
  server's run is its process. Each state names the run it is about; what arrives about an earlier
  run changes nothing.
- MS2. A call is made on the run that is ready.
- MS3. A server whose process could not be started has failed; a call to it fails with
  `McpFailed`, saying the server is not running and why.
- MS4. A server whose run ended has exited, and a call to it fails saying so, until it is
  reconnected (`reconnect`): the run there is ends (a remote server's session is ended), and
  another starts and is connected anew.
- MS5. A server that does not answer `initialize` and list its tools within `connectTimeout` has
  failed, and its run is stopped: nothing is left behind.
- MS6. A remote server that no longer has the session (a 404 to a request that carried it) is given
  a new one (`initialize` again), and the request it refused is made again, once, said in a warning
  (`mcp.server.session_renewed`). An HTTP+SSE server whose stream ends between requests is
  connected anew (`mcp.server.connection_lost`). A request whose stream ended before its answer
  fails, and is not made again: whether it ran is not known. When a new connection cannot be made,
  the run has ended; when the server refuses the credentials or asks for them, it has failed or
  needs authorization (MS7).
- MS7. A remote server that answers 401 or 403, connecting or to a request once ready (a key
  revoked), needs authorization when its headers give no
  credentials (an `Authorization` header, or one named for a credential: `X-API-Key`), saying
  whether it asks for OAuth (a `WWW-Authenticate` that names OAuth's metadata), which this client
  does not do; with credentials given, it has failed: they were refused.
- MH1. Streamable HTTP: each message is a POST to the server's URL, accepting JSON and SSE. The
  server answers 202 (a notification or a response), one JSON message, or an SSE stream: what it
  asks during the request, then its answer; an event with no data (a stream's priming) carries no
  message. Once it has answered `initialize`, each message carries
  its session (`Mcp-Session-Id`) and the version agreed (`MCP-Protocol-Version`). A GET stream with
  them carries what the server sends unasked, unless it answers 405; it is opened again a second
  after it ends. When the connection's scope closes, the session is ended (DELETE).
- MH2. HTTP+SSE: a GET stream to the server's URL; the URL its `endpoint` event gives is where each
  message is posted; every message from the server comes on the stream, and the connection ends
  with it.
- MH3. A request the endpoint refuses fails with what HTTP said (`rejectionOf`: its status, its
  `WWW-Authenticate`, the start of its body, and whether the session had ended); a server not
  reached is status 0. The headers a server is given go with every request, and are never logged;
  its URL is logged without its query. An HTTP+SSE endpoint's 404 is the session ended, as its URL
  carries the session.
- MT1. A server's tools are offered under `mcp__<server>`; every character of the server's or a
  tool's name that providers do not take in a tool's name (anything but letters, digits, `_` and
  `-`) is offered as `_`. A tool whose name is then longer than 64 characters, or the same as
  another of the server's, is left out, and the reason is given.
- MT2. A tool the server says only reads (`readOnlyHint`) is of kind `read` and safe to run again;
  one it says is idempotent (`idempotentHint`) is idempotent; any other is of kind `other` and
  unsafe to run again.
- MT3. A call's input must be a JSON object; other input is refused (`InputRejected`). Its result
  is recorded as the server sent it (`mcpToolResult`); one with `isError: true` is the tool's
  failure (`Reported`). A call the server does not answer fails `Reported`, saying why.
- MK1. A session's servers are started at once, in its scope. Once all have settled, the tools of
  those that are ready are tool sources, in the order the servers were given.
- MK2. The model is told, once, of each server that is not running when it is first asked, and of
  each that stops later; and once more when one runs again. A server ready when the session starts
  is not mentioned.
- MK3. Each change of a server's state is recorded as `McpServerChanged`, from the state it is in
  when recording starts; a server still connecting is not recorded. A server that is ready offers its
  tools by the names they are offered under. `reconnect` starts a server's process again and gives
  its state once it has settled.

