/**
 * A small MCP server over stdio, for the client's tests: newline-delimited JSON-RPC on stdin and
 * stdout. It answers `initialize` with the version offered; lists its tools in two pages (`echo`,
 * then `roots` and `slow`); `echo` answers its `message`; `roots` asks the client for its roots
 * (`roots/list`) and answers with them; `slow` never answers, and when the client cancels it
 * (`notifications/cancelled`) the server logs "cancelled <id>" (`notifications/message`); an
 * unknown tool is the error -32602. After `notifications/initialized` it logs "initialized".
 */

const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const tools = {
  echo: { name: "echo", description: "Answers its message.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] }, annotations: { readOnlyHint: true } },
  roots: { name: "roots", description: "Answers with the client's roots.", inputSchema: { type: "object" } },
  slow: { name: "slow", description: "Never answers.", inputSchema: { type: "object" } },
};
/** Calls waiting for the client's answer to the server's own request, by that request's id. */
const asked = new Map<string, number | string>();
let next = 0;

const handle = (message: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }) => {
  if (message.method === undefined) {
    // A response to the server's own request.
    const call = asked.get(String(message.id));
    if (call !== undefined) write({ jsonrpc: "2.0", id: call, result: { content: [{ type: "text", text: JSON.stringify(message.result) }] } });
    return;
  }
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      return write({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: params["protocolVersion"], capabilities: { tools: { listChanged: true }, logging: {} }, serverInfo: { name: "fake", version: "1.0.0" } },
      });
    case "notifications/initialized":
      return write({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "initialized" } });
    case "notifications/cancelled":
      return write({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: `cancelled ${String(params["requestId"])}` } });
    case "tools/list":
      return write({
        jsonrpc: "2.0",
        id: message.id,
        result: params["cursor"] === "2" ? { tools: [tools.roots, tools.slow] } : { tools: [tools.echo], nextCursor: "2" },
      });
    case "tools/call": {
      const args = (params["arguments"] ?? {}) as Record<string, unknown>;
      switch (params["name"]) {
        case "echo":
          return write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(args["message"]) }] } });
        case "roots": {
          const id = `s${next++}`;
          asked.set(id, message.id as number | string);
          return write({ jsonrpc: "2.0", id, method: "roots/list" });
        }
        case "slow":
          return;
        default:
          return write({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Unknown tool: ${String(params["name"])}` } });
      }
    }
    default:
      if (message.id !== undefined) write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
};

let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk.toString();
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) if (line.trim() !== "") handle(JSON.parse(line));
});
process.stderr.write("fake MCP server ready\n");
