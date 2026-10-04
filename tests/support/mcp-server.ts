/**
 * A small MCP server over stdio, for the client's tests: newline-delimited JSON-RPC on stdin and
 * stdout, doing what `mcp-fake.ts` says. `exit` ends the server's process with exit code 7, and is
 * listed only when `MCP_FAKE_EXIT=1`. With `MCP_FAKE_NO_LIST=1` it never answers `tools/list`.
 */

import { makeFake } from "./mcp-fake.ts";

const handle = makeFake((message) => process.stdout.write(`${JSON.stringify(message)}\n`), {
  noList: process.env["MCP_FAKE_NO_LIST"] === "1",
  exit: () => process.exit(7),
  listExit: process.env["MCP_FAKE_EXIT"] === "1",
});

let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk.toString();
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) if (line.trim() !== "") handle(JSON.parse(line));
});
process.stderr.write("fake MCP server ready\n");
