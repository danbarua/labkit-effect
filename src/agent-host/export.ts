/**
 * A session's transcript as Markdown, read from its facts alone: the body of a host's `/export`.
 * Where it is written is the host's business. Nothing is asked of a model or of the blob store:
 * bytes held outside the facts are named by their id and size.
 *
 * Facts are walked in order. A turn opens at `TurnStarted`; the inputs it is given show where they
 * are delivered (`InputDelivered`), each response where it was recorded (`ModelResponded`), and a
 * tool call with its response, together with what was asked before it ran and how it ended, found
 * by its id further on. A call whose response was never recorded (a stream stopped before it was
 * whole) shows where it arrived (`ToolCallArrived`).
 */

import { Schema } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import type { Ending } from "../agent-machine/decision.ts";
import type { CallId, ModelName, ProviderName, Seq, ToolName } from "../agent-machine/names.ts";
import type { InputSource, Observation, ToolFailure, ToolOutcome } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";
import { PermissionAnswer, questionIn } from "../agent-policy/permissions.ts";
import { contextGauge, costIn, requestsIn } from "../agent-session/accounting.ts";
import { asText } from "../agent-session/received.ts";
import { blobPointer } from "../agent-session/shaping.ts";

type Observed<T extends Observation["_tag"]> = Extract<Observation, { _tag: T }>;

/** How much of a tool's output a transcript shows: 8 KiB of its UTF-8 bytes. */
const shownOutputBytes = 8 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A fence longer than any run of backticks in `text`, so the text cannot close it. */
const fenced = (text: string, language = ""): string => {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
};

const languageOf = (received: Received): string => (received.mediaType === "application/json" ? "json" : "");

/**
 * A tool's output or error as Markdown: text fenced, cut at `shownOutputBytes` (never inside a
 * character) with a line saying how many bytes were left out; bytes named, and not read.
 */
const toolContent = (received: Received): string => {
  if (received.body._tag !== "Text") return asText(received);
  const bytes = encoder.encode(received.body.text);
  if (bytes.length <= shownOutputBytes) return fenced(received.body.text, languageOf(received));
  let cut = shownOutputBytes;
  // A byte 10xxxxxx continues a character: cut before the byte that starts it.
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  const left = bytes.length - cut;
  return `${fenced(decoder.decode(bytes.subarray(0, cut)), languageOf(received))}\n\n_Cut at 8 KiB: ${left} bytes more were left out._`;
};

/** A model as the transcript names it. */
const named = (provider: ProviderName, model: ModelName): string => `\`${provider}/${model}\``;

const speaker = (from: InputSource): string => {
  switch (from._tag) {
    case "User":
      return "User";
    case "System":
      return "System";
    case "Agent":
      return `Agent \`${from.agent}\``;
    default:
      return from satisfies never;
  }
};

const input = (arrived: Observed<"InputArrived">): ReadonlyArray<string> => [
  `### ${speaker(arrived.from)}`,
  arrived.text,
  ...(arrived.attachments === undefined || arrived.attachments.length === 0
    ? []
    : [arrived.attachments.map((blob) => `- Attachment: ${blobPointer(blob)}`).join("\n")]),
];

const failure = (tool: ToolName, reason: ToolFailure): ReadonlyArray<string> => {
  switch (reason._tag) {
    case "Reported":
      return ["Failed; the tool reported:", toolContent(reason.error)];
    case "NotFound":
      return [`Failed: no tool is named \`${tool}\`.`];
    case "InputRejected":
      return [`Failed: the tool rejected its input: ${reason.problem}`];
    case "Vetoed":
      return [`Vetoed: ${asText(reason.reason)}`];
    case "Indeterminate":
      return ["Indeterminate: the tool began to run and how it ended was not observed. It may have had effects."];
    case "NotRun":
      return ["Not run."];
    default:
      return reason satisfies never;
  }
};

const outcome = (tool: ToolName, ended: ToolOutcome | undefined): ReadonlyArray<string> => {
  if (ended === undefined) return ["No outcome is recorded."];
  return ended._tag === "Succeeded" ? ["Output:", toolContent(ended.output)] : failure(tool, ended.reason);
};

/** What was asked before a call ran and how it was answered, in one line. */
const permission = (asked: Received, answered: Received | undefined): string => {
  const question = questionIn(asked);
  const asks = question === undefined ? `Permission asked: ${asText(asked)}` : `Permission asked (${question.options.map((option) => option.name).join(" / ")})`;
  if (answered === undefined) return `${asks}; no answer is recorded.`;
  const picked = answered.body._tag === "Text" ? Schema.decodeOption(Schema.fromJsonString(PermissionAnswer))(answered.body.text) : undefined;
  const option = picked?._tag === "Some" ? question?.options.find((each) => each.optionId === picked.value.optionId) : undefined;
  return `${asks}; answered: ${option === undefined ? asText(answered) : option.name}.`;
};

/** How a turn that did not end in an answer ended; nothing for one that did. */
const ending = (ended: Ending): ReadonlyArray<string> => {
  switch (ended._tag) {
    case "Completed":
      return [];
    case "Incomplete":
      return ["_The turn ended with no answer._"];
    case "CutShort":
      return ["_The turn ended cut short: the model's response stopped at a limit._"];
    case "Failed":
      return [`_The turn failed: ${ended.failure}_`];
    case "Vetoed":
      return [`_A request to the model was vetoed, and the turn ended: ${asText(ended.reason)}_`];
    case "Interrupted":
      return ["_The turn was interrupted._"];
    default:
      return ended satisfies never;
  }
};

interface Call {
  readonly call: CallId;
  readonly tool: ToolName;
  readonly input: Received;
}

/** What the facts say of each call and input, by its id or position, for the walk to look up. */
interface Index {
  readonly inputs: ReadonlyMap<Seq, Observed<"InputArrived">>;
  readonly changes: ReadonlyMap<Seq, Observed<"ModelChangeArrived">>;
  readonly asked: ReadonlyMap<CallId, Received>;
  readonly answered: ReadonlyMap<CallId, Received>;
  readonly ended: ReadonlyMap<CallId, ToolOutcome>;
  /** The calls a recorded response holds. */
  readonly responded: ReadonlySet<CallId>;
}

const indexOf = (facts: ReadonlyArray<Fact>): Index => {
  const observed = facts.flatMap((fact) => (fact._tag === "Observed" ? [{ seq: fact.seq, observation: fact.observation }] : []));
  const each = <T extends Observation["_tag"]>(tag: T): ReadonlyArray<{ readonly seq: Seq; readonly observation: Observed<T> }> =>
    observed.flatMap(({ seq, observation }) => (observation._tag === tag ? [{ seq, observation: observation as Observed<T> }] : []));
  return {
    inputs: new Map(each("InputArrived").map(({ seq, observation }) => [seq, observation])),
    changes: new Map(each("ModelChangeArrived").map(({ seq, observation }) => [seq, observation])),
    asked: new Map(each("PermissionAsked").map(({ observation }) => [observation.call, observation.asks])),
    answered: new Map(each("PermissionAnswered").map(({ observation }) => [observation.call, observation.answer])),
    ended: new Map(each("ToolEnded").map(({ observation }) => [observation.call, observation.outcome])),
    responded: new Set(
      each("ModelResponded").flatMap(({ observation }) => observation.parts.flatMap((part) => (part._tag === "ToolCall" ? [part.call] : []))),
    ),
  };
};

const toolCall = (index: Index, call: Call): ReadonlyArray<string> => {
  const asked = index.asked.get(call.call);
  return [
    `#### Tool call \`${call.tool}\` (\`${call.call}\`)`,
    call.input.body._tag === "Text" ? fenced(call.input.body.text, languageOf(call.input)) : asText(call.input),
    ...(asked === undefined ? [] : [permission(asked, index.answered.get(call.call))]),
    ...outcome(call.tool, index.ended.get(call.call)),
  ];
};

const response = (index: Index, responded: Observed<"ModelResponded">): ReadonlyArray<string> => [
  "### Assistant",
  ...responded.parts.flatMap((part): ReadonlyArray<string> => {
    switch (part._tag) {
      case "Text":
      case "Commentary":
        return [part.text];
      case "Thinking":
        return part.text === "" ? [] : ["<details>\n<summary>Thinking</summary>", part.text, "</details>"];
      case "ToolCall":
        return toolCall(index, part);
      case "Unrecognised":
        return [`_A part of the response was not recognised: ${asText(part.received)}_`];
      default:
        return part satisfies never;
    }
  }),
];

/** The models the session asked, in order: the one it opened with, then each change taken. */
const modelsOf = (facts: ReadonlyArray<Fact>, index: Index): ReadonlyArray<{ readonly provider: ProviderName; readonly model: ModelName }> =>
  facts.flatMap((fact) => {
    if (fact._tag === "Observed") return fact.observation._tag === "SessionOpened" ? [fact.observation.model] : [];
    const change = fact.decision._tag === "ModelChangeTaken" ? index.changes.get(fact.decision.change) : undefined;
    return change === undefined ? [] : [change];
  });

const footer = (facts: ReadonlyArray<Fact>, models: ReadonlyArray<{ readonly provider: ProviderName; readonly model: ModelName }>): ReadonlyArray<string> => {
  const turns = facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === "TurnStarted" ? [fact.observation.turn] : []));
  const requests = turns.reduce((total, turn) => total + requestsIn(facts, turn), 0);
  const usages = facts.flatMap((fact) =>
    fact._tag === "Observed" && fact.observation._tag === "ModelResponded" && fact.observation.usage !== undefined ? [fact.observation.usage] : [],
  );
  const sum = (count: (usage: (typeof usages)[number]) => number | undefined) => usages.reduce((total, usage) => total + (count(usage) ?? 0), 0);
  const cache = [
    ...(sum((usage) => usage.cacheRead) > 0 ? [`${sum((usage) => usage.cacheRead)} read from the cache`] : []),
    ...(sum((usage) => usage.cacheWrite) > 0 ? [`${sum((usage) => usage.cacheWrite)} written to it`] : []),
  ];
  const thinking = sum((usage) => usage.thinking);
  const tokens =
    usages.length === 0
      ? "none reported"
      : `${sum((usage) => usage.input)} in${cache.length === 0 ? "" : ` (${cache.join(", ")})`}, ${sum((usage) => usage.output)} out${thinking > 0 ? ` (${thinking} of them thinking)` : ""}`;
  const now = models.at(-1);
  const gauge = now === undefined ? undefined : contextGauge(facts, now.provider, now.model);
  return [
    "## Totals",
    [
      `- Turns: ${turns.length}`,
      `- Model requests: ${requests}`,
      `- Tokens, as the providers reported them: ${tokens}`,
      `- Cost: $${costIn(facts).toFixed(4)} (US dollars, for the responses from a model with a known price)`,
      ...(gauge === undefined || now === undefined ? [] : [`- Context: ${gauge.used} of ${gauge.size} tokens of ${named(now.provider, now.model)}`]),
    ].join("\n"),
  ];
};

/**
 * The transcript of the session `facts` hold, as Markdown: a heading with the session and the models
 * it asked; each turn in order, with its inputs, the model's answer text, its thinking in a collapsed
 * block, each tool call with its input, what was asked before it ran and how it ended, and how the
 * turn ended when not in an answer (or that it was left running); then the totals.
 */
export function markdownOf(facts: ReadonlyArray<Fact>): string {
  const index = indexOf(facts);
  const models = modelsOf(facts, index);
  const blocks: Array<string> = [];
  let running = false;
  let turns = 0;
  const leftRunning = () => {
    if (running) blocks.push("_The turn was left running: no ending is recorded._");
  };
  const inputsAt = (inputs: ReadonlyArray<Seq>) =>
    inputs.flatMap((seq) => {
      const arrived = index.inputs.get(seq);
      return arrived === undefined ? [`_No input is recorded at ${seq}._`] : input(arrived);
    });
  for (const fact of facts) {
    if (fact._tag === "Decided") {
      const decision = fact.decision;
      switch (decision._tag) {
        case "InputDelivered":
          blocks.push(...inputsAt(decision.inputs));
          break;
        case "InputDropped":
          blocks.push(
            "_Input given while the turn ran was dropped, as the turn did not end in an answer:_",
            ...inputsAt(decision.inputs),
          );
          break;
        case "ModelChangeTaken": {
          const change = index.changes.get(decision.change);
          if (change !== undefined) blocks.push(`_From here the session asks ${named(change.provider, change.model)}._`);
          break;
        }
        case "TurnEnded":
          blocks.push(...ending(decision.ending));
          running = false;
          break;
        default:
          break;
      }
      continue;
    }
    const observation = fact.observation;
    switch (observation._tag) {
      case "SessionOpened":
        blocks.push(
          `# Session \`${observation.session}\``,
          `${models.length > 1 ? "Models" : "Model"}: ${models.map(({ provider, model }) => named(provider, model)).join(", then ")}`,
        );
        break;
      case "TurnStarted":
        leftRunning();
        turns += 1;
        running = true;
        blocks.push(`## Turn ${turns}`);
        break;
      case "ModelResponded":
        blocks.push(...response(index, observation));
        break;
      case "ToolCallArrived":
        if (!index.responded.has(observation.call)) blocks.push("### Assistant", ...toolCall(index, observation));
        break;
      default:
        break;
    }
  }
  leftRunning();
  blocks.push(...footer(facts, models));
  return `${blocks.join("\n\n")}\n`;
}
