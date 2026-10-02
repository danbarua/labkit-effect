# Where Effect fits in the ACP library, and where it does not

A running note, kept while building `src/acp` on `effect@4.0.0-rc.118`. Each entry says what we use
from Effect, what we write ourselves instead, and why. Paths under `effect/` are in
`repos/effect/packages/effect/src/`.

## Use Effect for

- **Typed method sets: `RpcGroup` and `Rpc`.** Each ACP version's methods are an `RpcGroup` per
  direction (`schema/*.rpcs.gen.ts`). Handlers, callers and errors are typed from one declaration.
- **Request dispatch and per-request fibers: `RpcServer`.** Each incoming request runs in its own
  fiber, and interrupting that fiber is how `$/cancel_request` cancels a handler. `peer.ts` feeds
  it through `RpcServer.Protocol.make`.
- **Pending calls and cancellation: `RpcClient`.** It keeps the table of pending calls, and an
  interrupted call (for example, the loser of a `raceFirst`) sends an `Interrupt`, which `peer.ts`
  writes as `$/cancel_request`. Structured cancellation maps onto ACP's cancellation without extra
  bookkeeping.
- **NDJSON framing: `Stream.decodeText` and `Stream.splitLines`.** `stdio.ts` splits the byte
  stream into lines with these and parses each line itself (see below).
- **Payload and result codecs: `RpcSerialization.json.codecFor`.** `peer.ts` gets each rpc's JSON
  codec from it, the same codec `RpcServer` and `RpcClient` use, so validation and the lenient
  pass agree with what the RPC halves decode.
- **Schema codegen: `SchemaRepresentation.fromJsonSchemaMultiDocument` and `toCodeDocument`.**
  These turn the SDK's JSON Schemas into Effect Schema source (`scripts/acp-schema.ts`), so nobody
  hand-writes 130 method definitions.
- **Lenient decoding: `Schema.catchDecoding`.** It implements the SDK's
  `x-deserialize-default-on-error` per property, keeping a missing required key an error (AS5).
- **HTTP: `HttpRouter`, `HttpClient`, `encoding/Sse`.** The Streamable HTTP transport is built
  from these parts (`http.ts`), not from a ready-made RPC transport.
- **Version adapters: the shape of `McpProtocol` and `McpServer`.** One adapter per version, with
  gates on the negotiated profile. We copy the pattern, not the code (`protocol.ts`, `agent.ts`).
- **Process entry: `BunRuntime.runMain` running an Effect that completes.** `agent.runStdio`
  returns when stdin closes, and `runMain` turns that into exit code 0.

## Do not use Effect for

- **Reading and writing JSON-RPC: `RpcSerialization.ndJsonRpc`.** `src/acp` uses neither half.
  - Its decoder drops what the library must answer. A line that is not JSON is swallowed
    (`rpc/RpcSerialization.ts`, `try { items.push(JSON.parse(line)) } catch {}`), and a message
    that is not an object is skipped (`decodeJsonRpcRaw`). So -32700 and -32600 for those could
    never be sent. `stdio.ts` and `http.ts` parse each message themselves and pass a bad line on
    as `WireInput.Unparsable`.
  - Its encoder speaks Effect's own dialect: `Interrupt`, `Ack` and `Ping` go out as
    `@effect/rpc/*` notifications, errors as `{ _tag: "Cause", data: cause }`, and requests carry
    trace fields.

  No ACP peer understands that dialect, so `peer.ts` writes every message itself.
- **Answering unknown methods and bad params.** `RpcServer` turns an unknown tag or a payload that
  fails to decode into a `Die` defect. `peer.ts` answers -32601 and -32602 itself before handing the
  request over.
- **Handler defects, under `RpcServer`'s defaults.** By default a handler's defect is reported for
  the whole connection, under no request id. The other end's call then never settles, and an
  incoming connection-level `Defect` fails every pending `RpcClient` call. Run `RpcServer.make` with
  `disableFatalDefects: true` so each defect is answered -32603 on its own request.
- **Notifications, as `RpcServer` runs them.** `RpcServer` treats an incoming notification as a
  request. `peer.ts` gives each one a synthetic id and drops its `Exit`.
- **Lenient decoding of results, as `RpcClient` does it.** `RpcClient` decodes a response inside
  `Schema.Exit`, which first checks the value against the success schema's encoded side. The
  `catchDecoding` fallbacks never run there, so `availableModes: "none"` fails instead of becoming
  `[]`. `peer.ts` decodes each result with its method's success codec and encodes it back before
  `RpcClient` sees it (AP13).
- **Results the schema refuses, as `RpcClient` handles them.** `RpcClient` runs `decodeExit` and
  then `orDie`, so a non-conforming answer from a third-party agent becomes a defect in the caller,
  which `catchTag` cannot handle. `peer.ts` decodes the result first and fails just that call with
  the `JsonRpcError` -32603 "The result does not match <method>'s schema", whose `data` carries the
  result and the schema issue. The connection goes on (AP13).
- **Failing one call with `RpcClientError`.** `RpcClient` decodes each `Exit` with the rpc's error
  schema, and the only way to raise `RpcClientError` fails every pending call. So one bad response
  fails its own call with a `JsonRpcError`, which every rpc's error schema includes (AP14).
- **JSON Schema forms and keywords the importer does not take.** It refuses an object with sibling
  `anyOf`/`oneOf`, an `allOf` naming a union, and `not`. It also ignores `x-*` keywords. The
  generator rewrites those forms first and carries the `x-deserialize-*` markers through a
  `contentSchema` annotation, which the importer keeps.
- **Recursive definitions in `toCodeDocument`.** It would type a recursive definition as a codec
  whose encoded side equals its decoded side, which brands and lenient arrays are not. ACP has no
  recursive definition, so the generator refuses one.
- **ACP's Streamable HTTP, through `RpcServer.layerHttp`.** ACP's HTTP is not MCP's:
  - an `Acp-Connection-Id` header names the connection;
  - every POST except `initialize` is answered 202;
  - there is one SSE stream per connection and one per session;
  - DELETE ends the connection.

  `layerHttp` fits none of this.
- **Effect's stdio layers (`RpcServer.layerProtocolStdio`, `McpServer.layerStdio`).** When stdin
  ends they interrupt the fiber that built them, and `runMain` reports an interrupt as exit code
  130, not 0. Use an Effect that returns at end of input instead (`agent.runStdio`). A layer that
  does not end on EOF is worse: a `Layer.launch` of it under `runMain` stays alive after stdin
  closes, because `runMain` keeps the process alive.
- **Keep-alives, as `Bun.serve` sets them.** `Bun.serve` closes a connection after 10 s with no
  data, which kills a quiet SSE stream. `http.ts` writes a comment every 5 s (`keepAliveInterval`).
  This is a gap in Bun, not in Effect.

## TypeScript limits met through Effect's types

- **Handler types for extension groups.** TypeScript cannot type handler parameters from an
  `RpcGroup` declared in the same object literal as the handlers, or built inline with `.omit(…)`.
  The parameters become implicit `any`. So `implement(adapter, extensions, options)` takes the
  extension groups as their own argument, before the options.
