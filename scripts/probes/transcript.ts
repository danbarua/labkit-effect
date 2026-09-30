/**
 * A session's facts as Markdown for a person to read: one entry per fact, in order, with its
 * position, time and origin; what was said in full, everything else as its JSON.
 */

import { DateTime, Schema } from "effect";
import { Fact } from "../../src/agent-core/fact.ts";
import type { ModelPart, Observation } from "../../src/agent-core/observation.ts";
import type { Origin } from "../../src/agent-core/origin.ts";
import { asText } from "../../src/agent-effect/received.ts";

const fenced = (text: string, language = ""): string => `\`\`\`${language}\n${text}\n\`\`\``;

function originText(origin: Origin): string {
  switch (origin._tag) {
    case "User":
      return `user via ${origin.via}`;
    case "Session":
      return `session ${origin.session}`;
    case "Provider":
      return `provider ${origin.provider}`;
    case "Tool":
      return `tool ${origin.tool}`;
    case "Harness":
      return `harness: ${origin.part}`;
    case "Test":
      return `test: ${origin.name}`;
    default:
      return origin satisfies never;
  }
}

function partText(part: ModelPart): string {
  switch (part._tag) {
    case "Text":
    case "Commentary":
      return `**${part._tag}**\n\n${part.text}`;
    case "Thinking":
      return `**Thinking** (signature of ${part.signature.length} characters)\n\n${part.text === "" ? "_(no text returned)_" : part.text}`;
    case "ToolCall":
      return `**ToolCall** \`${part.tool}\` (${part.call})\n\n${fenced(asText(part.input), "json")}`;
    case "Unrecognised":
      return `**Unrecognised**\n\n${fenced(asText(part.received), "json")}`;
    default:
      return part satisfies never;
  }
}

function observationText(observation: Observation): string {
  switch (observation._tag) {
    case "SessionOpened":
      return [
        `session \`${observation.session}\`, asking ${observation.model.provider} / ${observation.model.model}`,
        observation.system === undefined ? "no system prompt" : `**System prompt**\n\n${asText(observation.system)}`,
        observation.tools === undefined ? "no tools" : `**Tools**\n\n${fenced(asText(observation.tools), "json")}`,
      ].join("\n\n");
    case "InputArrived":
      return observation.text;
    case "NoticeInserted":
      return observation.text;
    case "ModelResponded":
      return [
        `${observation.provider} / ${observation.model}, stopped: \`${observation.stop ?? "?"}\` (${observation.ending._tag})`,
        ...observation.parts.map(partText),
        `<details><summary>metadata</summary>\n\n${fenced(asText(observation.metadata), "json")}\n\n</details>`,
      ].join("\n\n");
    case "ModelFailed":
      return `${observation.failure}\n\n${fenced(asText(observation.error), "json")}`;
    case "ToolEnded":
      return observation.outcome._tag === "Succeeded"
        ? `${observation.call} succeeded\n\n${fenced(asText(observation.outcome.output))}`
        : `${observation.call} failed\n\n${fenced(JSON.stringify(observation.outcome.reason, null, 2), "json")}`;
    default:
      return fenced(JSON.stringify(observation, null, 2), "json");
  }
}

const encode = Schema.encodeSync(Fact);

export function transcript(title: string, facts: ReadonlyArray<Fact>): string {
  const entries = facts.map((fact) => {
    const time = DateTime.formatIso(fact.time);
    if (fact._tag === "Decided") {
      const { _tag, ...details } = (encode(fact) as { decision: { _tag: string } }).decision;
      return `### ${fact.seq}. decided ${_tag}\n\n\`${JSON.stringify(details)}\` at ${time}`;
    }
    return `### ${fact.seq}. ${fact.observation._tag}\n\nfrom ${originText(fact.origin)}, at ${time}\n\n${observationText(fact.observation)}`;
  });
  return `# ${title}\n\n${entries.join("\n\n")}\n`;
}
