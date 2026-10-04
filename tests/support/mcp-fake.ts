/**
 * What the test MCP servers do, whatever carries their messages (`mcp-server.ts` over stdio,
 * `mcp-http-server.ts` over HTTP). It answers `initialize` with the version offered; lists its tools
 * in two pages (`echo`, then `roots` and `slow`); `echo` answers its `message`; `roots` asks the client
 * for its roots (`roots/list`) and answers with them; `slow` never answers, and when the client
 * cancels it (`notifications/cancelled`) the server logs "cancelled <id>" (`notifications/message`);
 * an unknown tool is the error -32602. After `notifications/initialized` it logs
 * "initialized by <name> <version>", the `clientInfo` the client gave `initialize`.
 *
 * `send` is given each message the server sends, with the id of the client's request it belongs to,
 * if any: a transport that answers each request on a stream of its own sends it there.
 */

export type Id = number | string;

export interface Message {
  readonly id?: Id;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
}

export interface FakeOptions {
  /** Never answer `tools/list`. */
  readonly noList?: boolean;
  /** What a call to `exit` does; a server without it does not know the tool. */
  readonly exit?: (() => void) | undefined;
  /** List `exit` among the tools. */
  readonly listExit?: boolean;
}

const tools = {
  echo: { name: "echo", description: "Answers its message.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] }, annotations: { readOnlyHint: true } },
  roots: { name: "roots", description: "Answers with the client's roots.", inputSchema: { type: "object" } },
  slow: { name: "slow", description: "Never answers.", inputSchema: { type: "object" } },
  exit: { name: "exit", description: "Ends the server's process.", inputSchema: { type: "object" } },
};

/** One client's server: what it does with each message the client sends. */
export const makeFake = (send: (message: unknown, request?: Id) => void, options: FakeOptions = {}) => {
  const listed = options.listExit === true ? [tools.roots, tools.slow, tools.exit] : [tools.roots, tools.slow];
  /** What the client called itself in `initialize`. */
  let client = { name: "", version: "" };
  /** Calls waiting for the client's answer to the server's own request, by that request's id. */
  const asked = new Map<string, Id>();
  let next = 0;

  return (message: Message): void => {
    if (message.method === undefined) {
      // A response to the server's own request.
      const call = asked.get(String(message.id));
      if (call !== undefined) send({ jsonrpc: "2.0", id: call, result: { content: [{ type: "text", text: JSON.stringify(message.result) }] } }, call);
      return;
    }
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        client = (params["clientInfo"] ?? client) as typeof client;
        return send(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: params["protocolVersion"], capabilities: { tools: { listChanged: true }, logging: {} }, serverInfo: { name: "fake", version: "1.0.0" } },
          },
          message.id,
        );
      case "notifications/initialized":
        return send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: `initialized by ${client.name} ${client.version}` } });
      case "notifications/cancelled":
        return send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: `cancelled ${String(params["requestId"])}` } });
      case "tools/list":
        if (options.noList === true) return;
        return send({ jsonrpc: "2.0", id: message.id, result: params["cursor"] === "2" ? { tools: listed } : { tools: [tools.echo], nextCursor: "2" } }, message.id);
      case "tools/call": {
        const args = (params["arguments"] ?? {}) as Record<string, unknown>;
        switch (params["name"]) {
          case "echo":
            return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(args["message"]) }] } }, message.id);
          case "roots": {
            const id = `s${next++}`;
            asked.set(id, message.id as Id);
            return send({ jsonrpc: "2.0", id, method: "roots/list" }, message.id);
          }
          case "slow":
            return;
          default:
            // A server without `exit` does not know it.
            if (params["name"] === "exit" && options.exit !== undefined) return options.exit();
            return send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Unknown tool: ${String(params["name"])}` } }, message.id);
        }
      }
      default:
        if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }, message.id);
    }
  };
};
