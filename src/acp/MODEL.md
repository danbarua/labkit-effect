# acp

The Agent Client Protocol (ACP) in Effect: the protocol's schemas, a two-way JSON-RPC peer, and the
wires a connection runs over (stdio, Streamable HTTP). It is shaped like Effect's
`effect/ai/McpServer`, and its tests drive it with the official ACP SDK
(`@agentclientprotocol/sdk` 1.5.0), which the library itself never imports.

`json-rpc.ts` holds what every part shares: JSON-RPC's messages and error codes, and the `Wire`, one
connection's parsed messages. A wire carries whole messages; framing is the wire's business, and
what the messages mean is the peer's.

Each rule has an id, and at least one test whose name starts with that id; `bun run check:rules`
fails when a rule has none.

## Schemas

`schema/v1.gen.ts` and `schema/v2.gen.ts` are generated from the SDK's JSON Schemas by
`scripts/acp-schema.ts` (`bun run acp:schema`); do not edit them by hand.

- AS1. `src/acp/schema/v1.gen.ts`, `v2.gen.ts`, `v1.rpcs.gen.ts` and `v2.rpcs.gen.ts` are exactly
  what `scripts/acp-schema.ts` (`bun run acp:schema`) makes from the installed
  `@agentclientprotocol/sdk`'s `schema/schema.json` (protocol version 1) and
  `schema/v2/schema.unstable.json` (protocol version 2). Every `$def` is an exported Schema and a
  type of the same name, and the def's description is the doc comment of both.
- AS2. Each version has four `RpcGroup`s whose tags are method names. `AgentRequests` and
  `ClientRequests` pair each request def with its response def, with error `JsonRpcError`.
  `AgentNotifications` and `ClientNotifications` have a payload only. A method is on the side its
  `x-side` names, and `both` puts it on both sides. `mcp/message` is a request and also a
  notification. `$/cancel_request` is in no group. `unstable` holds every method with a def whose
  description says `**UNSTABLE**`.
- AS3. A value a method def accepts encodes to JSON that the SDK's zod schema for that def accepts,
  and what that zod schema outputs decodes back.
- AS4. The messages an SDK client and an SDK agent send each other in a turn decode, and encode
  back to the same JSON: initialize, session/new, session/prompt with text and resource_link
  blocks, session/update of six kinds, and session/request_permission with its response.
- AS5. A property marked `x-deserialize-default-on-error` that is present and fails to decode takes
  its JSON Schema `default`. With no default it is left out, or becomes `[]` if it is required (in
  both versions such a property is always a skip-invalid array, which is the SDK's fallback). A
  required key that is missing still fails. A field without the marker is refused, as the SDK
  refuses it. Encoding is unchanged.
- AS6. An array marked `x-deserialize-skip-invalid-items` decodes by dropping the items that fail to
  decode. Encoding refuses an invalid item.
- AS7. Every def that is a plain JSON string is a string branded `acp/<Name>`, with the same brand
  in v1 and v2. A plain string, or a different kind of id, is not one.
- AS8. The catch-all variant of an extensible union refuses an object whose tag belongs to a known
  variant, and keeps an unknown variant's other properties. An object that names properties and
  does not set `additionalProperties: true` drops properties it does not name when decoding.
- AS9. A `uri` is a string that `URL` parses once trimmed. A `date-time` matches the SDK's RFC 3339
  pattern (seconds required, `Z` or an offset). An integer format (`uint16`, `uint32`, `int32`, …)
  is bounded to its range. Each of these is checked as the SDK's zod schema checks it.

## The peer

`peer.ts` is one end of a connection: it serves the requests and notifications of one `RpcGroup`
and calls another, on Effect's `RpcServer` and `RpcClient`, with messages written by hand rather
than by Effect's JSON-RPC encoder. `stdio.ts` makes wires of newline-delimited JSON.

- AP1. The peer writes each message whole, one at a time, in the order it is sent. A handler's
  notifications and its own requests to the other end reach the other end before its response.
  Nothing of Effect's RPC dialect is written: no `@effect/rpc/*` messages, `_tag`, `headers`,
  `traceId` or `spanId`.
- AP2. When a call to the other end is interrupted, the peer sends `$/cancel_request { requestId }`
  with that call's id, and drops a response that arrives for it later.
- AP3. An incoming `$/cancel_request` interrupts the handler of the request it names, and that
  request is answered with -32800. A `$/cancel_request` for an id that is unknown or already
  answered is ignored.
- AP4. A handler that fails with a `JsonRpcError` answers its request with that error: code,
  message and data as given.
- AP5. A handler that dies answers its own request with -32603, and the connection goes on
  (`disableFatalDefects`).
- AP6. An unknown method is answered -32601, and params the method's payload schema refuses are
  answered -32602. Both are answered before any handler runs. A notification gets no response: one
  with an unknown method, or with params its schema refuses, is dropped; a known one is run by its
  handler, and its result is discarded. Any JSON-RPC id is answered under that same id, `null`
  included.
- AP7. A line that is not JSON is answered -32700 under id null. A JSON value that is not a
  JSON-RPC 2.0 message is answered -32600 under its id when the value has a string, number or null
  `id`, and otherwise under null. A malformed response is answered under null, because its id is
  one of this end's own.
- AP8. A batch (a JSON array) is answered with one array holding the response to each request in
  it, in any order. A batch of only notifications and responses gets nothing. An empty array is
  answered -32600 under id null.
- AP9. A response whose id matches no pending call is ignored.
- AP10. When the wire's `read` ends or fails, `closed` completes, every pending call fails with
  `RpcClientError` ("RpcClientDefect: The connection closed"), calls made afterwards fail the same
  way, running handlers are interrupted, and nothing more is written.
- AP11. `fromWebStreams` and `fromStdio` carry newline-delimited JSON. A message split across
  chunks is joined, several messages in one chunk are split, blank lines are skipped, and a line
  that is not JSON arrives as `Unparsable`. Each write is one line of `JSON.stringify` output with
  no indentation; a batch's responses are one array on one line.
- AP12. Over a real stdio subprocess (`peer-test-agent-stdio.ts` on `fromStdio`), the official SDK
  client runs a turn that includes a permission request, and the agent exits 0 when its stdin
  closes.
- AP13. The peer keeps the method of each request it sends until that request's response arrives.
  A success response with `result: null` reaches the caller as `{}` when the method's success
  schema, decoded with the JSON codec `RpcClient` uses, refuses `null` and accepts `{}`. The ACP
  SDK answers `null` when a handler returns nothing, and reads `null` as `{}` itself. Every other
  result reaches the caller unchanged; a `null` that the success schema refuses makes the call die
  on decoding.

## Streamable HTTP

`http.ts` is ACP's Streamable HTTP transport, both ends, each ACP connection one `Wire`. Where the
SDK's `experimental/server` and `experimental/http-client` differ from the RFD, it follows the SDK.
WebSocket is not built: a GET with `Upgrade: websocket` gets 426, as the SDK answers.

- AH1. `serve` answers a POST of `initialize` that has no `Acp-Connection-Id` with 200, the agent's
  response as the JSON body, and a new connection id in `Acp-Connection-Id`. It answers every other
  POST it accepts with 202 and no body. The agent's messages reach the client only on GET event
  streams, as `data: <json>` events. The SDK's `createHttpStream` client, used through
  `acp.client()`, runs initialize, session/new, and a prompt. During the prompt the agent sends
  updates and a `session/request_permission` request, which the client answers over POST, before
  the prompt's response.
- AH2. The agent's messages go to the stream of the session named in `params.sessionId` (session
  updates and the agent's own requests). The response to a client request goes to the stream of the
  session named by that request's `Acp-Session-Id`, or by its `params.sessionId` if the header is
  absent. Two sessions prompted at once each receive only their own updates.
- AH3. A message for a stream that no GET is reading is queued. The first GET on that stream
  receives it, including GETs on sessions the agent has not created yet.
- AH4. The response to `session/load` goes to the connection's stream, while that session's updates
  go to the session's stream. Responses to requests that named no session, and messages from the
  agent that name no session, also go to the connection's stream. A response whose
  `result.sessionId` names a session creates that session's stream.
- AH5. When the client answers an agent request that was about a session, the POST must carry that
  session's `Acp-Session-Id`: 400 `Missing Acp-Session-Id` without it, 400 `Mismatched
  Acp-Session-Id` with a different one. A request whose `params.sessionId` names a session, or whose
  method is session-scoped (`session/prompt`, `session/load`, `session/cancel`, and the rest of the
  SDK's list), must carry a matching `Acp-Session-Id` (400 otherwise).
- AH6. `serve` refuses what the SDK's `AcpServer` refuses, with the same statuses: 415 when the
  media type is not `application/json`; 400 for invalid JSON or a body that is not an object; 501
  for a batch; 400 for a missing `Acp-Connection-Id` on POST, GET or DELETE; 404 for an unknown one;
  400 for `initialize` on an existing connection; 406 for a GET without `text/event-stream` in
  `Accept`; 426 for a WebSocket upgrade; 405 for PUT and PATCH; 409 for a second GET; 202 for
  DELETE; 404 for a POST after DELETE. The test runs the same requests against both servers.
- AH7. Only one GET reads a stream at a time; a second GET on a stream that already has a reader is
  answered 409.
- AH8. DELETE (202) drops everything queued for the connection, closes its streams, ends `read` on
  its wire, interrupts `onConnection` and closes its scope. Later requests carrying its id get 404.
  Stopping the server (the layer's scope closes) does the same to every connection.
- AH9. If the agent's first message is not a response to `initialize` with the same id, or
  `onConnection` returns without answering, the POST is answered 500 with
  `{ jsonrpc: "2.0", id, error: { code: -32603, message: "Initialize failed", data: "Expected
  initialize response from agent" } }` and no `Acp-Connection-Id`, and the connection is discarded.
- AH10. `connect`, driven as raw JSON-RPC on its wire, completes the same exchange against the
  SDK's `AcpServer` (hosting an `acp.agent()`) and against `serve`: initialize; session/new; a
  prompt whose updates and permission request arrive, with the request answered over POST; and
  `session/load` of a session the client never saw.
- AH11. `connect` opens a session's stream, and waits until it is open, before POSTing its first
  message about that session. That covers a session learned from `result.sessionId` and a
  `session/load` of a session not seen before. Messages about a session carry `Acp-Session-Id`. So
  does the answer to an agent request that arrived on a session's stream; answers to requests from
  the connection's stream carry none.
- AH12. `connect` sends the caller's headers on every request. It stores cookies from every
  response's `Set-Cookie` and sends them on every later request; a caller `Cookie` with the same
  name wins.
- AH13. Closing `connect`'s scope interrupts its streams and any POST in flight, DELETEs the
  connection, and ends `read`. `read` also ends when the connection's stream ends, for example after
  something else DELETEs the connection.
- AH14. A POST or GET that does not get a 2xx fails the write with `<what>: <status>: <body>`, and
  `read` fails with the same error. After that, writes fail with `ACP HTTP stream is closed`. A
  batch written to either end's wire fails with `ACP Streamable HTTP does not carry JSON-RPC
  batches`.
