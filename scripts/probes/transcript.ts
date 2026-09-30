/**
 * A session's facts as Markdown for a person to read: one entry per fact, in the order recorded.
 * Each heading gives the fact's position, its name in the domain, and what it says in words. A
 * fact that points at another by position is shown with what it points at, and each request to the
 * model is shown with everything it carried.
 */

import { DateTime, Schema } from "effect";
import { Fact } from "../../src/agent-machine/fact.ts";
import type { Seq, TurnId } from "../../src/agent-machine/names.ts";
import type { ModelPart, Observation, ToolOutcome } from "../../src/agent-machine/observation.ts";
import type { Origin } from "../../src/agent-machine/origin.ts";
import type { ContextMessage, ContextPart } from "../../src/agent-session/contracts.ts";
import { asText } from "../../src/agent-session/received.ts";
import { sentIn } from "../../src/agent-session/sent.ts";

const fenced = (text: string, language = ""): string => `\`\`\`${language}\n${text}\n\`\`\``;
const quoted = (text: string): string => text.split("\n").map((line) => `> ${line}`).join("\n");

/** JSON on several lines when it parses, and the text as it is when it does not. */
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function originText(origin: Origin): string {
  switch (origin._tag) {
    case "User":
      return `the user, through ${origin.via}`;
    case "Session":
      return `session ${origin.session}`;
    case "Provider":
      return `the provider ${origin.provider}`;
    case "Tool":
      return `the tool ${origin.tool}`;
    case "Harness":
      return `the harness (${origin.part})`;
    case "Test":
      return `the run "${origin.name}"`;
    default:
      return origin satisfies never;
  }
}

function outcomeText(outcome: ToolOutcome): string {
  if (outcome._tag === "Succeeded") return `succeeded, with\n\n${fenced(asText(outcome.output))}`;
  const reason = outcome.reason;
  switch (reason._tag) {
    case "Reported":
      return `failed: the tool reported\n\n${fenced(asText(reason.error))}`;
    case "NotFound":
      return "failed: no tool has that name";
    case "InputRejected":
      return `failed: the tool did not accept the input (${reason.problem})`;
    case "Vetoed":
      return `failed: vetoed\n\n${fenced(asText(reason.reason))}`;
    case "Indeterminate":
      return "failed: the tool began to run and how it ended was not observed";
    case "NotRun":
      return "failed: the call was not run";
    default:
      return reason satisfies never;
  }
}

/** One part of a response, or of a message sent, in words. */
function partText(part: ModelPart | ContextPart): string {
  switch (part._tag) {
    case "Text":
      return quoted(part.text);
    case "Commentary":
      return `commentary (what the model says it is doing; not its answer):\n\n${quoted(part.text)}`;
    case "Thinking":
      return [
        `thinking (${asText(part.received).length} characters, which the provider needs back unchanged)${part.text === "" ? ": no text was returned" : ":"}`,
        ...(part.text === "" ? [] : [quoted(part.text)]),
      ].join("\n\n");
    case "ToolCall":
      return `a call to the tool \`${part.tool}\` (call \`${part.call}\`), with input\n\n${fenced(pretty(asText(part.input)), "json")}`;
    case "ToolResult":
      return `the result of call \`${part.call}\`: ${outcomeText(part.outcome)}`;
    case "Unrecognised":
      return `a part the adapter does not recognise, kept as received:\n\n${fenced(pretty(asText(part.received)), "json")}`;
    default:
      return part satisfies never;
  }
}

const messageText = (message: ContextMessage, index: number): string =>
  [`${index + 1}. **${message.role}**`, ...message.parts.map(partText)].join("\n\n");

/** How many of `messages`, from the first, the request before carried unchanged. */
function carriedBefore(messages: ReadonlyArray<ContextMessage>, before: ReadonlyArray<ContextMessage>): number {
  const same = (at: number) => JSON.stringify(messages[at]) === JSON.stringify(before[at]);
  const differs = messages.findIndex((_, at) => at >= before.length || !same(at));
  return differs === -1 ? messages.length : differs;
}

const encode = Schema.encodeSync(Fact);

/** `about` says where the facts came from: what was run, and against what. */
export function transcript(title: string, about: string, facts: ReadonlyArray<Fact>): string {
  const inputs = new Map<Seq, string>(
    facts.flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "InputArrived" ? [[fact.seq, fact.observation.text] as const] : [],
    ),
  );
  // How many requests each turn has made so far, and the messages the request before carried.
  const requests = new Map<TurnId, number>();
  const state = { before: [] as ReadonlyArray<ContextMessage> };

  const observed = (observation: Observation): { readonly says: string; readonly body: string } => {
    switch (observation._tag) {
      case "SessionOpened":
        return {
          says: `session \`${observation.session}\` opened, asking ${observation.model.provider} / ${observation.model.model}`,
          body: [
            `Settings: ${observation.model.settings === undefined ? "none said" : `\`${JSON.stringify(observation.model.settings)}\``}`,
            observation.system === undefined ? "No system prompt." : `**System prompt**\n\n${quoted(asText(observation.system))}`,
            observation.tools === undefined ? "No tools." : `**Tools**\n\n${fenced(pretty(asText(observation.tools)), "json")}`,
          ].join("\n\n"),
        };
      case "InputArrived":
        return { says: `input arrived, from ${observation.from._tag === "Agent" ? `the agent ${observation.from.agent}` : `the ${observation.from._tag.toLowerCase()}`}`, body: quoted(observation.text) };
      case "TurnStarted":
        return { says: `turn \`${observation.turn}\` started`, body: "It takes the input that is waiting." };
      case "ModelRequestDispatched": {
        const count = (requests.get(observation.turn) ?? 0) + 1;
        requests.set(observation.turn, count);
        const sent = sentIn(observation.sent);
        const already = carriedBefore(sent.messages, state.before);
        state.before = sent.messages;
        const rendered = sent.messages.map(messageText);
        return {
          says: `request ${count} of \`${observation.turn}\` was made, to ${observation.provider} / ${observation.model}`,
          body: [
            "This is everything the request carried.",
            sent.system === undefined ? "**System prompt:** none" : `**System prompt**\n\n${quoted(sent.system)}`,
            `**Tools:** ${sent.tools.length === 0 ? "none" : sent.tools.map((tool) => `\`${tool.name}\``).join(", ")}`,
            `**Messages** (${sent.messages.length})`,
            ...(already === 0
              ? []
              : [
                  `<details><summary>Messages 1 to ${already}, as the request before carried them</summary>\n\n${rendered.slice(0, already).join("\n\n")}\n\n</details>`,
                ]),
            ...rendered.slice(already),
          ].join("\n\n"),
        };
      }
      case "ToolCallArrived":
        return {
          says: `a call to \`${observation.tool}\` arrived while the response was still arriving`,
          body: `Call \`${observation.call}\`. It is run at once; the response, when it is recorded, holds the same call.\n\n${fenced(pretty(asText(observation.input)), "json")}`,
        };
      case "ToolCallDispatched":
        return { says: `call \`${observation.call}\` was handed to its tool`, body: "" };
      case "ToolEnded":
        return { says: `call \`${observation.call}\` ended`, body: `It ${outcomeText(observation.outcome)}` };
      case "ModelResponded":
        return {
          says: `the response to request ${requests.get(observation.turn) ?? "?"} of \`${observation.turn}\`, from ${observation.provider} / ${observation.model}`,
          body: [
            `It stopped as \`${observation.stop ?? "not said"}\`, which the adapter reads as ${observation.ending._tag}. Its parts, in order:`,
            ...(observation.parts.length === 0 ? ["(none)"] : observation.parts.map((part, index) => `${index + 1}. ${partText(part)}`)),
            `<details><summary>Everything else the provider returned with it</summary>\n\n${fenced(pretty(asText(observation.metadata)), "json")}\n\n</details>`,
          ].join("\n\n"),
        };
      case "ModelFailed":
        return { says: `the request of \`${observation.turn}\` failed`, body: `${observation.failure}\n\n${fenced(pretty(asText(observation.error)), "json")}` };
      case "NoticeInserted":
        return { says: `a notice went into the request of \`${observation.turn}\``, body: quoted(observation.text) };
      case "TurnEndReviewed":
        return { says: `nothing more was given to \`${observation.turn}\` before it ends`, body: "" };
      case "TurnInterrupted":
        return { says: `\`${observation.turn}\` was interrupted`, body: "" };
      default:
        return { says: "", body: fenced(JSON.stringify(observation, null, 2), "json") };
    }
  };

  const entries = facts.map((fact) => {
    const time = DateTime.formatIso(fact.time);
    if (fact._tag === "Decided") {
      const decision = fact.decision;
      const { _tag, ...details } = (encode(fact) as { decision: { _tag: string } }).decision;
      const says = ((): { readonly says: string; readonly body: string } => {
        switch (decision._tag) {
          case "InputDelivered":
            return {
              says: `the input at ${decision.inputs.join(", ")} is given to \`${decision.turn}\``,
              body: decision.inputs.map((input) => quoted(inputs.get(input) ?? "(no input is recorded there)")).join("\n\n"),
            };
          case "ModelAsked":
            return {
              says: `the model is to be sent the next request of \`${decision.turn}\``,
              body: "The request, with what it carries, is the entry that follows.",
            };
          case "TurnEnded":
            return { says: `\`${decision.turn}\` ended: ${decision.ending._tag}`, body: "" };
          default:
            return { says: "", body: `\`${JSON.stringify(details)}\`` };
        }
      })();
      return [`### ${fact.seq}. decided ${_tag}${says.says === "" ? "" : `: ${says.says}`}`, `Decided by the core, at ${time}.`, says.body]
        .filter((line) => line !== "")
        .join("\n\n");
    }
    const { says, body } = observed(fact.observation);
    return [
      `### ${fact.seq}. ${fact.observation._tag}${says === "" ? "" : `: ${says}`}`,
      `Observed; reported by ${originText(fact.origin)}, at ${time}.`,
      body,
    ]
      .filter((line) => line !== "")
      .join("\n\n");
  });
  return [
    `# ${title}`,
    about,
    "Each entry is one fact of the session, in the order recorded. An observation is something that reached the harness from outside, with who reported it; a decision is the core's own. A heading gives the fact's position, its name, and what it says.",
    ...entries,
  ].join("\n\n")
    .concat("\n");
}
