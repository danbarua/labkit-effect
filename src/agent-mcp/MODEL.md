# agent-mcp

An MCP client: one connection to one MCP server over the server's stdio (a child process),
newline-delimited JSON-RPC. MCP's messages are Effect's (`effect/ai` `McpSchema`); the JSON-RPC
peer is a copy of `effective-acp`'s (`peer.ts`), with MCP's cancellation. Effect's `RpcClient` was
tried first (TODO.md, the MCP servers entry): it drops what a server sends unasked.

## What is built

- `client.ts`: `connectStdio(server, roots)` starts the server in the scope it is given and gives the
  connection: what the server answered to `initialize`, its tools (`tools`), and `call`.
- `peer.ts`: one JSON-RPC connection that serves requests and makes them.
- `server-machine.ts`, `server.ts`: one MCP server a session keeps, over its process group
  (`agent-process`): `startMcpServer(server, roots)` starts it in the scope given and connects on
  each run of its process; `reconnect` starts the process again; `call` calls a tool of the run
  that is ready. A server must answer `initialize` within `connectTimeout` (30 seconds unless a
  host says).
- `source.ts`: a server's tools as a tool source, under the namespace `mcp__<server>`.

## What is not built

- The Streamable HTTP transport, and the SSE one.
- The MCP servers an ACP client names in `session/new` or a CLI is configured with.
- Sampling and elicitation: the client does not offer them, so a server does not ask.
- A change of a server's tool list (`notifications/tools/list_changed`) is logged, not acted on;
  so are tools a reconnected server lists that it did not list before.

## Rules

- MC1. The client offers `initialize` its latest version (`protocolVersion`) and keeps what the
  server answers; then it sends `notifications/initialized`. `tools` lists every page, by
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
- MS1. A server is `Connecting` while its process starts and answers `initialize`, then `Ready`
  with the tools it listed. It has `Failed` when its process could not be started or it did not
  connect (its process is then stopped), and `Exited` when its process ended. Each state names the
  process's run it is about; what arrives about an earlier run changes nothing.
- MS2. A call is made on the run that is ready.
- MS3. A server whose process could not be started has failed; a call to it fails with
  `McpFailed`, saying the server is not running and why.
- MS4. A server whose process ended has exited, and a call to it fails saying so, until it is
  reconnected (`reconnect`): its process starts again, as a new run, and is connected anew.
- MS5. A server that does not answer `initialize` within `connectTimeout` has failed, and its
  process group is stopped: none is left behind.
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

