/**
 * How a tool's output is sent to the model, when it is recorded in a form the model is not to be
 * sent as it is. An MCP server's result is recorded as the server sent it (`mcpToolResult`: a JSON
 * object with `content` blocks), and sent as plain text: each text block's text; an embedded text
 * resource's text; a resource link as a Markdown link; an image or audio block as a line naming it;
 * and `structuredContent`, as JSON, when no block gives text. Any other output is sent as recorded.
 */

import { MediaType, type Received } from "../agent-machine/received.ts";
import { asText, parseJson, receivedText } from "./received.ts";
import type { ToolOutcome } from "../agent-machine/observation.ts";

/** The media type an MCP server's tool result is recorded under. */
export const mcpToolResult = MediaType.make("application/vnd.modelcontextprotocol.call-tool-result+json");

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** One content block, as text. */
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

/** An MCP server's result as plain text. */
const mcpResultText = (output: Received): Received => {
  const parsed = parseJson(output);
  if (!("value" in parsed) || !isObject(parsed.value)) return receivedText(asText(output));
  const content = Array.isArray(parsed.value["content"]) ? parsed.value["content"] : [];
  const texts = content.flatMap(blockText);
  const structured = parsed.value["structuredContent"];
  return receivedText(texts.length === 0 && structured !== undefined ? JSON.stringify(structured) : texts.join("\n"));
};

/** A tool call's outcome as the model is sent it. */
export const outcomeAsSent = (outcome: ToolOutcome): ToolOutcome => {
  if (outcome._tag === "Succeeded") return outcome.output.mediaType === mcpToolResult ? { ...outcome, output: mcpResultText(outcome.output) } : outcome;
  const reason = outcome.reason;
  return reason._tag === "Reported" && reason.error.mediaType === mcpToolResult ? { ...outcome, reason: { ...reason, error: mcpResultText(reason.error) } } : outcome;
};
