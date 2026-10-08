/**
 * How a tool's output is sent to the model when it is recorded in a form that the model must not be
 * sent. An MCP server's result is recorded as the server sent it (`mcpToolResult`: a JSON object with
 * `content` blocks), and sent as plain text, one line per block:
 * - a text block: its text;
 * - an embedded text resource: its text;
 * - a resource link: a Markdown link;
 * - an image or audio block: a line naming its type and media type.
 *
 * When no block gives text, `structuredContent` is sent as JSON. Any other output is sent as
 * recorded. A result's details (`ToolDetail`) are never sent.
 */

import { MediaType, type Received } from "../agent-machine/received.ts";
import { asText, parseJson, receivedText } from "./received.ts";
import type { ToolOutcome } from "../agent-machine/observation.ts";

/** The media type under which an MCP server's tool result is recorded. */
export const mcpToolResult = MediaType.make("application/vnd.modelcontextprotocol.call-tool-result+json");

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Returns one content block as lines of text. */
const blockText = (block: unknown): ReadonlyArray<string> => {
  if (!isObject(block)) return [];
  switch (block["type"]) {
    case "text":
      return typeof block["text"] === "string" ? [block["text"]] : [];
    case "resource_link":
      return [`[${String(block["name"] ?? block["uri"])}](${String(block["uri"])})`];
    case "resource": {
      const resource = block["resource"];
      if (!isObject(resource)) return [];
      return typeof resource["text"] === "string" ? [resource["text"]] : [`[resource: ${String(resource["uri"])}]`];
    }
    case "image":
    case "audio":
      return [`[${String(block["type"])}: ${String(block["mimeType"])}]`];
    default:
      return [];
  }
};

/** Returns an MCP server's result as plain text. */
const mcpResultText = (output: Received): Received => {
  const parsed = parseJson(output);
  if (!("value" in parsed) || !isObject(parsed.value)) return receivedText(asText(output));
  const content = Array.isArray(parsed.value["content"]) ? parsed.value["content"] : [];
  const texts = content.flatMap(blockText);
  const structured = parsed.value["structuredContent"];
  return receivedText(texts.length === 0 && structured !== undefined ? JSON.stringify(structured) : texts.join("\n"));
};

/** Returns a tool call's outcome as the model is sent it. */
export const outcomeAsSent = (outcome: ToolOutcome): ToolOutcome => {
  if (outcome._tag === "Succeeded") return { _tag: "Succeeded", output: outcome.output.mediaType === mcpToolResult ? mcpResultText(outcome.output) : outcome.output };
  const reason = outcome.reason;
  return reason._tag === "Reported" && reason.error.mediaType === mcpToolResult ? { ...outcome, reason: { ...reason, error: mcpResultText(reason.error) } } : outcome;
};
