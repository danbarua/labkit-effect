# agent-mcp

An MCP client: one connection to one MCP server over the server's stdio (a child process),
newline-delimited JSON-RPC. MCP's messages are Effect's (`effect/ai` `McpSchema`); the JSON-RPC
peer is a copy of `effective-acp`'s (`peer.ts`), with MCP's cancellation. Effect's `RpcClient` was
tried first (TODO.md, the MCP servers entry): it drops what a server sends unasked.

## What is built

- `client.ts`: `connectStdio(server, roots)` starts the server in the scope it is given and gives the
  connection: what the server answered to `initialize`, its tools (`tools`), and `call`.
- `peer.ts`: one JSON-RPC connection that serves requests and makes them.

## What is not built

- The Streamable HTTP transport, and the SSE one.
- A server's tools as a tool source (`agent-session/tool-sources.ts`, `mcp__<server>`), and the MCP
  servers an ACP client names in `session/new` or a CLI is configured with.
- Sampling and elicitation: the client does not offer them, so a server does not ask.
- A change of a server's tool list (`notifications/tools/list_changed`) is logged, not acted on.

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
