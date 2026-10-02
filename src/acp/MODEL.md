# acp

The Agent Client Protocol (ACP) in Effect: the protocol's schemas, a two-way JSON-RPC peer, the
wires a connection runs over (stdio, Streamable HTTP), and an agent and a client that negotiate the
protocol version and each other's capabilities. It is shaped like Effect's `effect/ai/McpServer`,
and its tests drive it with the official ACP SDK (`@agentclientprotocol/sdk` 1.5.0), which the
library itself never imports.

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
- AS2. Each version has four method sets (`methods.ts`) keyed by method name. `AgentRequests` and
  `ClientRequests` hold a request per request def, its params decoded by the request def and its
  result by the response def; every request's error is `JsonRpcError`. `AgentNotifications` and
  `ClientNotifications` hold a notification per notification def, with params only. A method is on
  the side its `x-side` names, and `both` puts it on both sides. `mcp/message` is a request and also
  a notification. `$/cancel_request` is in no set. `unstable` holds every method with a def whose
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
  refuses it. Encoding is unchanged. Over the wire the same holds for what an end receives: the
  SDK's v1 client sends `agent.run` `clientCapabilities.fs.readTextFile: "yes"`, which the profile
  holds as `false`, and the SDK's v1 agent answers `client.connect`'s `session/new` with
  `modes.availableModes: "none"`, which the call returns as `[]` (AP13).
- AS6. An array marked `x-deserialize-skip-invalid-items` decodes by dropping the items that fail to
  decode. Encoding refuses an invalid item. Over the wire, an `annotations.audience` of
  `["user", 5, "assistant"]` in a prompt block from the SDK's v1 client reaches the agent's
  `session/prompt` handler as `["user", "assistant"]`, and the same in a `session/update` from the
  SDK's v1 agent reaches the client's handler as `["user", "assistant"]`; neither is refused.
- AS7. Every def that is a plain JSON string is a string branded `acp/<Name>`, with the same brand
  in v1 and v2. A plain string, or a different kind of id, is not one.
- AS8. The catch-all variant of an extensible union refuses an object whose tag belongs to a known
  variant, and keeps an unknown variant's other properties. An object that names properties and
  does not set `additionalProperties: true` drops properties it does not name when decoding.
- AS9. A `uri` is a string that `URL` parses once trimmed. A `date-time` matches the SDK's RFC 3339
  pattern (seconds required, `Z` or an offset). An integer format (`uint16`, `uint32`, `int32`, …)
  is bounded to its range. Each of these is checked as the SDK's zod schema checks it.

## The peer

`peer.ts` is one end of a connection: it serves the requests and notifications of one method set
and calls another (`methods.ts`). The sets only declare the methods and their schemas; the peer
reads and writes every JSON-RPC message itself. `stdio.ts` makes wires of newline-delimited JSON.

- AP1. The peer writes each message whole, one at a time, in the order it is sent. A handler's
  notifications and its own requests to the other end reach the other end before its response.
  Nothing of Effect's RPC dialect is written: no `@effect/rpc/*` messages, `_tag`, `headers`,
  `traceId` or `spanId`.
- AP2. When a call to the other end is interrupted after its request was written, the peer sends
  `$/cancel_request { requestId }` with that call's id, and drops a response that arrives for it
  later. A call interrupted before its request was written sends nothing.
- AP3. An incoming `$/cancel_request` interrupts the handler of the request it names, and that
  request is answered with -32800. A `$/cancel_request` for an id that is unknown or already
  answered is ignored.
- AP4. A handler that fails with a `JsonRpcError` answers its request with that error: code,
  message and data as given, and nothing else. A failure value with more to it (a tagged error
  class shaped like a `JsonRpcError`) goes out as its `code`, `message` and `data` only, with no
  `_tag` or other field; an error response reaches the caller the same way.
- AP5. A handler that dies answers its own request with -32603, and the connection goes on.
- AP6. An unknown method is answered -32601, and params the method's payload schema refuses are
  answered -32602. Both are answered before any handler runs. A notification gets no response: one
  with an unknown method, or with params its schema refuses, is dropped; a known one is run by its
  handler, and its result is discarded. Any JSON-RPC id is answered under that same id, `null`
  included.
- AP7. A line that is not JSON is answered -32700 under id null. A JSON value that is not a
  JSON-RPC 2.0 message is answered -32600 under its id when the value has a string, number or null
  `id`, and otherwise under null. A malformed response is answered under null, because its id is
  one of this end's own, and the call it names fails (AP14).
- AP8. A batch (a JSON array) is answered with one array holding the response to each request in
  it, in any order. A batch of only notifications and responses gets nothing. An empty array is
  answered -32600 under id null.
- AP9. A response whose id matches no pending call is ignored.
- AP10. When the wire's `read` ends or fails, `closed` completes, every pending call fails with
  `PeerClosed` ("The connection closed"), calls made afterwards fail the same way, running handlers
  are interrupted, and nothing more is written.
- AP11. `fromWebStreams` and `fromStdio` carry newline-delimited JSON. A message split across
  chunks is joined, several messages in one chunk are split, blank lines are skipped, and a line
  that is not JSON arrives as `Unparsable`. Each write is one line of `JSON.stringify` output with
  no indentation; a batch's responses are one array on one line.
- AP12. Over a real stdio subprocess (`peer-test-agent-stdio.ts` on `fromStdio`), the official SDK
  client runs a turn that includes a permission request, and the agent exits 0 when its stdin
  closes.
- AP13. The peer keeps the method of each request it sends until that request's response arrives.
  Every result is decoded with the method's success schema, so the schema's default-on-error and
  skip-invalid-items fallbacks apply. A success response with `result: null` reaches the caller as
  `{}` when the method's success schema refuses `null` and accepts `{}`. The ACP SDK answers `null`
  when a handler returns nothing, and reads `null` as `{}` itself. A result the success schema
  refuses, `null` included, fails its call with the `JsonRpcError` `{ code: -32603, message: "The
  result does not match <method>'s schema", data: { result, issue } }`, `result` being the result
  as received and `issue` the schema's issue as text. That is a failure the caller can handle, not
  a defect, and a later response for that id is ignored (AP9). When the SDK's v1 agent answers
  `session/new` with a numeric `sessionId`, the client's call fails so, and its next `session/new`
  succeeds.
- AP14. A malformed response is an object with no `method` and a `result` or an `error` that is not
  a well-formed response: `jsonrpc` other than `"2.0"`, an `id` that is not a string, number or
  null, an `error` without an integer `code` and a string `message`, or both `result` and `error`.
  It is answered -32600 under id null (AP7). When its `id` is that of a pending call, that call fails
  at once with the `JsonRpcError` `{ code: -32600, message: "The response to this request is
  malformed", data: { response } }`, `response` being the message as received, and a later
  response for that id is ignored (AP9).

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
  connection, and ends `read`. If the connection's stream ends while the scope is open (because
  something else DELETEd the connection, the agent ended it, or a server or proxy dropped the
  stream), `read` fails with `ACP connection SSE stream closed`, and the connection is torn down
  and DELETEd. A session's stream that ends while a request about that session waits for its
  response fails `read` with `ACP session SSE stream closed: <sessionId>`. Otherwise the session
  is forgotten, and its stream is opened again when a message names it.
- AH14. A POST or GET that does not get a 2xx fails the write with `<what>: <status>: <body>`, and
  `read` fails with the same error. After that, writes fail with `ACP HTTP stream is closed`. A
  batch written to either end's wire fails with `ACP Streamable HTTP does not carry JSON-RPC
  batches`.
- AH15. `serve` sends a keep-alive comment (`:`) on each event stream as soon as it opens, then
  every `keepAliveInterval` (default 5 seconds), so a stream with nothing to send outlives a
  server's idle timeout. Under `Bun.serve` with `idleTimeout: 1` and a 200 ms interval, the
  connection's stream stays open for 2.5 s with nothing to send, and then delivers a message the
  agent sends.

## Negotiation

`protocol.ts` holds one `ProtocolAdapter` per protocol version (`v1`, `v2`), modelled on Effect's
`McpProtocol`: the version's method sets, how it writes and reads `initialize`, and its capability
gates. `agent.ts` and `client.ts` are the two ends. Each takes one implementation per version it
speaks, answers or sends `initialize` itself, and then serves the chosen implementation's handlers
behind the gates (`endpoint.ts`). A capability counts as advertised when it is present and neither
`null` nor `false`. A refusal names the capability by its path in the `initialize` message that
advertises it.

- AN1. `select(supported, offered)` is `offered` when `supported` holds it. Otherwise it is the
  highest version in `supported`, even when `offered` is lower than every supported version.
- AN2. `agent.run` answers `initialize` itself. It reads `protocolVersion` from the params as an
  integer from 0 to 65535, the same way in every version, and chooses the implementation with
  `select`. It decodes the params with that version's `InitializeRequest` schema and answers in that
  version's field names. Version 1 answers with `agentCapabilities`, `agentInfo` and `authMethods`
  (AN12). Version 2 answers with `capabilities` and `info`, and with `authMethods` only when the list
  is not empty. Params with no such `protocolVersion`, or params that schema refuses, are answered
  -32602, and the connection stays uninitialized. The SDK's v1 client gets 1 from an agent that
  implements 1 and 2. The SDK's v2 client gets 2. A raw `initialize` offering 3 is answered 2. An
  agent that implements only version 1 answers a version 2 client with 1, and the SDK's v2 client
  then fails its request with a schema error on `info`.
- AN3. Until `initialize` is answered, the agent answers a request with -32600 and
  `data: { reason: "not_initialized" }`. In a batch, each request is answered and the answers go out
  as one array; an `initialize` inside a batch is answered the same way. A line that is not JSON is
  answered -32700 under id null, and anything else is dropped. Once initialized, a second
  `initialize` is answered -32600 with `data: { reason: "already_initialized" }`. Until the client's
  `initialize` is answered, the client answers a request from the agent with -32600 not_initialized
  and drops anything else.
- AN4. An incoming request that a gate refuses is answered before its handler runs. The answer is
  -32601 when the method itself needs the capability, and -32602 when only its params do. It
  carries the gate's message and `data: { capability }`. An incoming notification that a gate
  refuses is dropped. A method the implementation has no handler for is answered -32601
  `Method not found: <method>`, with no `data`. Params that the method's schema refuses are answered
  -32602 before that, as for every method (AP6).
- AN5. An end's calls to the other end (`client` and `notify` on the agent, `agent` and `notify` on
  the client) go through the gates under the negotiated profile. A refused call fails with
  `CapabilityNotAdvertised { method, capability, message }`, and nothing is written. The agent's
  `fs/read_text_file` is refused when the SDK client did not advertise `fs`, and the SDK client
  answers it when it did. The agent's `elicitation/create` is refused when the client advertised
  `elicitation: {}`. The agent's `session/update` of kind `notice` is refused without
  `session.notices`. The client's `session/load` is refused when the agent did not advertise
  `loadSession`.
- AN6. Each `ProtocolAdapter` has a `stability`: `v1` is `stable`, and `v2`, the SDK's draft, is
  `experimental`. `client.connect` sends `initialize` with id 0, offering `offer` in that version's
  field names. Left out, `offer` is the highest stable version the client implements, or the
  highest experimental one when it implements no stable version. An `offer` it does not implement
  is a defect. It reads the answer's `protocolVersion` the same way in every version and continues
  with the implementation for that version. The profile's client side is what the agent received:
  the params sent, decoded with the answered version's `InitializeRequest` schema, and the client's
  own gates use that profile. A client implementing 1 (with `fs` and `terminal`) and 2 offers 1 by
  default, the SDK's v1 agent receives its `clientCapabilities` and `clientInfo`, and the agent's
  `fs/read_text_file` reaches its handler. Offering 2, it sends `capabilities` and `info`, which
  version 1 does not name: when the SDK's v1 agent answers 1, the profile has no client
  capabilities and no client info, and the client answers the agent's `fs/read_text_file` -32601.
  If no implementation matches, `connect` fails with `UnsupportedProtocolVersion { offered,
  answered }` and stops reading the wire. It fails with `InitializeFailed` when the agent answers
  with an error or with a malformed response (AP14), when the answer has no `protocolVersion`, when
  the answered version's schema refuses the answer or the params sent, when the wire closes first,
  or when the request cannot be written. A client implementing 1 and 2 gets 1 from the SDK's v1
  agent and from `agent.run` implementing both; offering 2, it gets 2 from the SDK's v2 agent, and
  2 or 1 from `agent.run` implementing both or only 1. A client implementing only 2 offers 2, and
  fails against an agent implementing only 1.
- AN7. A request from the agent that the client's gates refuse is answered as in AN4. An
  `elicitation/create` in mode `form` or `url` that the client did not advertise gets -32602.
  `fs/read_text_file` without `fs.readTextFile` gets -32601.
- AN8. `agent.runStdio` runs `run` on `fromStdio` with `References.LogToStderr` set, so stdout
  carries only protocol messages, and returns when stdin closes. In a subprocess whose program is
  `runStdio` under `BunRuntime.runMain`, the SDK's client runs a turn with a permission request over
  pipes; every stdout line is JSON-RPC, the negotiation log line is on stderr, and once the client
  closes the process's stdin the process exits 0 on its own. `agent.layerHttp` runs one `run` per
  connection on `http.serve` (`path`, `keepAliveInterval`), and the SDK's `createHttpStream` client
  runs the same turn against it. `client.connect` over `http.connect` runs the same turn against the
  SDK's `AcpServer`.
- AN9. Answering `initialize` is logged at Info as `acp.initialize.negotiated`:
  `{ side: "agent", offered, chosen, supported }` on the agent, and `{ side: "client", offered,
  chosen }` on the client. An incoming refusal is logged at Info as
  `acp.gate.refused_incoming { side, method, capability, code }`. A local refusal is logged at
  Debug as `acp.gate.refused_locally { side, method, capability }`. A routine exchange logs no
  Warning or Error.
- AN10. Version 1's gates. From client to agent: `session/load` needs
  `agentCapabilities.loadSession`. `session/resume`, `close`, `list`, `delete` and `fork` need
  `agentCapabilities.sessionCapabilities.<name>`. `logout` needs `agentCapabilities.auth.logout`.
  `mcp/message` needs `agentCapabilities.mcpCapabilities.acp`. `providers/*` needs
  `agentCapabilities.providers`, `nes/*` needs `agentCapabilities.nes`, and `document/<event>` needs
  `agentCapabilities.nes.events.document.<event>`; all of these are method gates. Params gates:
  `authenticate` needs a `methodId` that is in `authMethods` and is not of type `terminal`. In
  `session/prompt`, an `image`, `audio` or `resource` block needs
  `agentCapabilities.promptCapabilities.image`, `audio` or `embeddedContext`. In `session/new`,
  `load`, `resume` and `fork`, a non-empty `additionalDirectories` needs
  `agentCapabilities.sessionCapabilities.additionalDirectories`, and an MCP server of type `http`,
  `sse` or `acp` needs `agentCapabilities.mcpCapabilities.<type>`. From agent to client:
  `fs/read_text_file` and `fs/write_text_file` need `clientCapabilities.fs.readTextFile` and
  `writeTextFile`. `terminal/*` needs `clientCapabilities.terminal`. `elicitation/complete` needs
  `clientCapabilities.elicitation.url`. `mcp/*` needs the agent's own
  `agentCapabilities.mcpCapabilities.acp`; all of these are method gates. Params gates:
  `elicitation/create` in mode `form` or `url` needs `clientCapabilities.elicitation.<mode>`; other
  modes are custom and pass. A `session/update` of kind `plan_update` or `plan_removed` needs
  `clientCapabilities.plan`. Kind `notice` needs `clientCapabilities.session.notices`. Kinds
  `compaction_update` and `compaction_summary_chunk` need `clientCapabilities.session.compaction`.
  A `config_option_update` with a `boolean` option needs
  `clientCapabilities.session.configOptions.boolean`.
- AN11. Version 2's gates, from the v2 defs' descriptions (the v2 SDK enforces none). From client to
  agent: every `session/*` method, `session/cancel` included, needs `capabilities.session`.
  `session/delete` and `session/fork` also need `capabilities.session.delete` and
  `capabilities.session.fork`. `auth/login` and `auth/logout` need the `authMethods` the agent
  answered with (AN12) to be non-empty. `mcp/message` needs `capabilities.session.mcp.acp`.
  `providers/*` needs `capabilities.providers`, `nes/*` needs `capabilities.nes`, and
  `document/<event>` needs `capabilities.nes.events.document.<event>`; all of these are method
  gates. Params gates: `auth/login` needs a `methodId` that is advertised and is not of type
  `terminal`. In `session/prompt`, an `image`, `audio` or `resource` block needs
  `capabilities.session.prompt.image`, `audio` or `embeddedContext`. In `session/new`, `resume` and
  `fork`, a non-empty `additionalDirectories` needs `capabilities.session.additionalDirectories`, and
  an MCP server of type `stdio`, `http` or `acp` needs `capabilities.session.mcp.<type>`. From agent
  to client: `elicitation/complete` needs the client's `capabilities.elicitation.url`, and `mcp/*`
  needs the agent's `capabilities.session.mcp.acp` (method gates). `elicitation/create` in mode
  `form` or `url` needs the client's `capabilities.elicitation.<mode>` (params gate). Version 2 has
  no client capability for any `session/update` kind, `notice` included, and none for
  `session/request_permission`.
- AN12. `agent.run` answers `initialize` without the `authMethods` of type `terminal` unless the
  client advertised terminal auth: `clientCapabilities.auth.terminal` in version 1,
  `capabilities.auth.terminal` in version 2. The profile holds the list answered. The SDK's v1
  client gets a terminal method only with `auth: { terminal: true }`, and the SDK's v2 client only
  with `auth: { terminal: {} }`. Without it, a version 2 agent whose only method is a terminal one
  answers no `authMethods`, and the client's `auth/login` is answered -32601.
- AN13. `agent.implement` and `client.implement` take, before their options, the extension
  methods the implementation serves, calls and sends (`Extensions { serve, call, notify }`, each a
  method set). Every method name in them starts with `_`; `implement` throws when one does not. The
  served ones are handled in the same handler record as the version's methods, as requests or
  notifications. The connection's `extensions.call` (a function per method of `call`, by name) and
  `extensions.notify` (of `notify`) send the outgoing ones. No gate refuses a method whose name
  starts with `_`. An extension method with no handler, or one the implementation does not
  declare, is answered -32601 (AN4, AP6). An agent of `agent.ts` and a client of `client.ts` call
  and notify each other's extension methods, and the SDK client's `request` and `notify` of `_`
  methods reach the agent's handlers.
- AN14. A connection never reuses one of its own request ids. The client sends `initialize` as id
  0, before the peer starts, and the peer numbers the client's later requests from 1
  (`Peer.make`'s `firstId`), so a late or repeated answer to `initialize` cannot settle another
  call. The agent sends no request before its peer starts, and its peer numbers from 0.
