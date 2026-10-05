/**
 * An MCP server's tools as a tool source (`agent-session/tool-sources.ts`), offered under the
 * namespace `mcp__<server>`, so `mcp__github__search`.
 * - Providers accept tool names of letters, digits, `_` and `-`, at most 64 characters. Every other
 *   character of a server's or a tool's name is replaced by `_`. A tool whose name is still too long,
 *   or the same as another's after replacement, is not offered, and the reason is returned
 *   (`left`).
 * - A tool is of kind `read` and safe to run again when the server says it only reads
 *   (`readOnlyHint`); idempotent when the server says so (`idempotentHint`); otherwise of kind
 *   `other` and unsafe to run again.
 * - A call's input must be a JSON object. The result is recorded as the server sent it
 *   (`mcpToolResult`); a result with `isError: true` is the tool's failure, `Reported`. A call that
 *   the server does not answer (it is not running, or the request failed) fails `Reported`, with the
 *   reason.
 */

import { Effect, type Schema } from "effect";
import type { McpSchema } from "effect/ai";
import { FailureText, ToolName } from "../agent-machine/names.ts";
import type { ToolOutcome } from "../agent-machine/observation.ts";
import { ReceivedText } from "../agent-machine/received.ts";
import type { ToolSpec } from "../agent-session/contracts.ts";
import { parseJson, receivedText } from "../agent-session/received.ts";
import { mcpToolResult } from "../agent-session/tool-output.ts";
import type { ToolSource } from "../agent-session/tool-sources.ts";
import type { McpServer } from "./server.ts";

/** The maximum length of a tool name that providers accept. */
export const maxToolName = 64;

/** Returns `name` with every character that providers do not accept in a tool name replaced by `_`. */
const offerable = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, "_");

/** Returns the namespace that a server's tools are offered under. */
export const namespaceOf = (server: string): string => `mcp__${offerable(server)}`;

export interface McpToolSource {
  readonly source: ToolSource;
  /** The tools not offered, each with the reason. */
  readonly left: ReadonlyArray<{ readonly tool: string; readonly reason: string }>;
}

const specOf = (name: string, tool: McpSchema.Tool): ToolSpec => {
  const hints = tool.annotations;
  return {
    name: ToolName.make(name),
    description: tool.description ?? tool.title ?? "",
    input: tool.inputSchema as unknown as Schema.Json,
    kind: hints?.readOnlyHint === true ? "read" : "other",
    replay: replayOf(hints),
  };
};

/** Returns whether a tool is safe to run again, from what the server says of it: that it only reads, or that it is idempotent. */
const replayOf = (hints: McpSchema.Tool["annotations"]): ToolSpec["replay"] => {
  if (hints?.readOnlyHint === true) return "safe";
  if (hints?.idempotentHint === true) return "idempotent";
  return "unsafe";
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Returns `server`'s `tools` (those it listed when it was ready) as a tool source. */
export const mcpToolSource = (server: McpServer, tools: ReadonlyArray<McpSchema.Tool>): McpToolSource => {
  const namespace = namespaceOf(server.name);
  const named = tools.map((tool) => ({ tool, name: offerable(tool.name) }));
  const left = named.flatMap(({ tool, name }, index) => {
    if (`${namespace}__${name}`.length > maxToolName) return [{ tool: tool.name, reason: `${namespace}__${name} is longer than ${maxToolName} characters` }];
    if (named.findIndex((other) => other.name === name) !== index) return [{ tool: tool.name, reason: `${tool.name} is offered as ${name}, as another of the server's tools is` }];
    return [];
  });
  const kept = named.filter(({ tool }) => !left.some((each) => each.tool === tool.name));
  const own = new Map(kept.map(({ tool, name }) => [name, tool.name] as const));
  const reported = (text: string): ToolOutcome => ({ _tag: "Failed", reason: { _tag: "Reported", error: receivedText(text) } });
  return {
    left,
    source: {
      namespace,
      tools: kept.map(({ tool, name }) => specOf(name, tool)),
      run: (tool, input) => {
        const name = own.get(tool);
        if (name === undefined) return Effect.succeed<ToolOutcome>({ _tag: "Failed", reason: { _tag: "NotFound" } });
        const parsed = parseJson(input);
        if (!("value" in parsed) || !isObject(parsed.value))
          return Effect.succeed<ToolOutcome>({ _tag: "Failed", reason: { _tag: "InputRejected", problem: FailureText.make(`${namespace}__${tool} takes a JSON object as its input.`) } });
        return server.call(name, parsed.value).pipe(
          Effect.map((result): ToolOutcome => {
            const received = { mediaType: mcpToolResult, body: { _tag: "Text" as const, text: ReceivedText.make(JSON.stringify(result)) } };
            return result["isError"] === true ? { _tag: "Failed", reason: { _tag: "Reported", error: received } } : { _tag: "Succeeded", output: received };
          }),
          Effect.catchTag("McpFailed", (error) => Effect.succeed(reported(error.message))),
        );
      },
    },
  };
};
