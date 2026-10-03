# Where Effect fits in the ACP library, and where it does not

A running note, kept while building `src/acp` on `effect@4.0.0-rc.118`, and `4.0.0` since. Each entry says what we use
from Effect, what we write ourselves instead, and why. Paths under `effect/` are in
`repos/effect/packages/effect/src/`.

## Use Effect for

- **Per-request fibers and cancellation: `FiberMap`.** Each incoming request's handler runs in a
  fiber of a `FiberMap` keyed by the request's id. An incoming `$/cancel_request` interrupts that
  fiber (`FiberMap.remove`), and the handler's `Effect.onExit` answers -32800.
- **Pending calls: `Deferred`, and interruption.** Each outgoing call waits on a `Deferred`, kept by
  id until its response completes it. An interrupted call (for example, the loser of a
  `raceFirst`) still pending sends `$/cancel_request` from its `Effect.onExit`. Structured
  cancellation maps onto ACP's cancellation without extra bookkeeping.
- **Write order: `Semaphore`.** One permit: each message is written whole, in the order it is sent.
- **Lifetime: `Scope` and `FiberSet`.** The reader, the building of the handlers, and a `FiberSet`
  of the other fibers (notification handlers, batches waiting for their answers, cancellations)
  all live in the peer's scope. When the wire's read ends, the peer fails pending calls with
  `PeerClosed` and clears the `FiberMap` and the `FiberSet`, which interrupts running handlers.
- **Reading the wire: `Stream.runForEach`.** `peer.ts` handles one wire input at a time, in order.
- **NDJSON framing: `Stream.decodeText` and `Stream.splitLines`.** `stdio.ts` splits the byte
  stream into lines with these and parses each line itself (see below).
- **Params and result codecs: `Schema.toCodecJson`.** `peer.ts` decodes each incoming request's
  params once with its method's JSON codec, answering -32602 when the codec refuses them, and
  hands the decoded value to the handler. It decodes each result once, so the `catchDecoding`
  fallbacks apply to it (AP13).
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
- **Work after a response: `Effect.fiber` and `Fiber.await`.** A handler's response is written from
  its own fiber before the fiber ends (AP15), so a handler that forks `Fiber.await(self)` and then
  a notification has the notification written after its response: the ACP host announces
  `/export` (`available_commands_update`) only once the client has the session's id. No callback
  or hook in the library is needed.
- **What a connection keeps: the `Scope` that `Effect.scoped` gives `run`.** The handlers are built
  and run in it (AN15), so an implementation keeps per-connection resources (the ACP host's
  sessions, each a child scope from `Scope.fork`) there, and they close when the connection ends,
  before `run` returns. `run`'s requirements exclude `Scope.Scope`.

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
- **Declaring, serving and calling JSON-RPC methods: `Rpc`, `RpcGroup`, `RpcServer` and
  `RpcClient`.** Effect's RPC is an Effect-to-Effect protocol (used by its cluster); a JSON-RPC peer
  fits the primitives. `src/acp` imports nothing from `effect/rpc`.
  - `Rpc` declares an error schema per method, besides middleware, streaming and services. ACP has
    no per-method error: every request's error is `JsonRpcError`. `methods.ts` declares a method
    as its name, its params schema and, for a request, its result schema, and types handlers and
    callers from that (`Handlers`, `Caller`, `Notify`).

  Fitting JSON-RPC through `RpcServer` and `RpcClient` took a workaround for each of these:
  - `RpcServer` turns an unknown tag or a payload that fails to decode into a `Die` defect, so
    -32601 and -32602 had to be answered before handing the request over.
  - By default `RpcServer` reports a handler's defect for the whole connection, under no request
    id. The other end's call then never settles, and an incoming connection-level `Defect` fails
    every pending `RpcClient` call. It needed `disableFatalDefects: true`.
  - `RpcServer` runs an incoming notification as a request, so each one needed a synthetic id and
    its `Exit` dropped.
  - `RpcClient` decodes a response inside `Schema.Exit`, which first checks the value against the
    success schema's encoded side, where the `catchDecoding` fallbacks never run
    (`availableModes: "none"` fails instead of becoming `[]`). Each result had to be decoded and
    encoded back before `RpcClient` saw it.
  - `RpcClient` runs `decodeExit` and then `orDie`, so a result the schema refuses becomes a defect
    in the caller, which `catchTag` cannot handle. The result had to be checked first.
  - The only way to raise `RpcClientError` fails every pending call, so one malformed response
    could not fail just its own call with it.
- **JSON Schema forms and keywords the importer does not take.** It refuses an object with sibling
  `anyOf`/`oneOf`, an `allOf` naming a union, and `not`. It also ignores `x-*` keywords. The
  generator rewrites those forms first and carries the `x-deserialize-*` markers through a
  `contentSchema` annotation, which the importer keeps.
- **Brands in `toCodeDocument`.** From `4.0.0` it writes no brand: a brand is a TypeScript
  distinction that a representation does not hold (`rc.118` wrote a `brands` annotation as
  `Schema.brand`). The generator adds the brand to each definition it brands, on its type and its
  schema.
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
- **Shaping what goes on the wire with `Schema.is`.** `Schema.is` on a `Struct` accepts extra
  properties, and so does TypeScript's structural typing. A handler that fails with a
  `Data.TaggedError` shaped like a `JsonRpcError` passes both, and written as received it would put
  `_tag` and its other fields on the wire. `peer.ts` writes every error as a new object holding only
  `code`, `message` and `data` (AP1, AP4). Use `Schema.is` to check a value, never to decide that
  the value can be sent as it is.

## TypeScript limits

- **Handler types for inline extension sets.** TypeScript cannot type handler parameters from a
  served method set built inline in the extensions argument (`Methods.make(…)` or `set.omit(…)`),
  nor from one declared in the same object literal as the handlers (a single options object). The
  parameters become implicit `any`. So `implement(adapter, extensions, options)` takes the
  extension sets as their own argument, before the options, and a served set is built beforehand.
