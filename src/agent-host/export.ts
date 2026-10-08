/**
 * A session's transcript as Markdown, read from its facts alone: the body of a host's `/export`. The
 * host decides where it is written. No model and no blob store is asked: bytes kept outside the
 * facts are named by their id and size.
 *
 * The facts are read in order. A turn opens at `TurnStarted`. Its inputs are shown where they are
 * delivered (`InputDelivered`), each response where it was recorded (`ModelResponded`), and each tool
 * call with its response, together with the permission question and how the call ended, which are
 * looked up by the call's id. A call whose response was never recorded (a stream stopped before the
 * response was complete) is shown where it arrived (`ToolCallArrived`).
 */

import { Array as Arr } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import type { Decision, Ending } from "../agent-machine/decision.ts";
import type { CallId, FailureText, ModelName, ProviderName, Seq, ToolName } from "../agent-machine/names.ts";
import type { InputSource, Observation, ToolFailure, ToolOutcome } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";
import { answerIn, optionPicked, questionIn } from "../agent-policy/permissions.ts";
import { contextGauge, costIn } from "../agent-session/accounting.ts";
import { requestsIn } from "../agent-machine/turn-requests.ts";
import { asText } from "../agent-session/received.ts";
import { blobPointer } from "../agent-session/shaping.ts";

type Observed<T extends Observation["_tag"]> = Extract<Observation, { _tag: T }>;

/** The amount of a tool's output that a transcript shows: 8 KiB of its UTF-8 bytes. */
const shownOutputBytes = 8 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Returns `text` fenced with more backticks than any run of backticks it contains, so the text cannot close the fence. */
const fenced = (text: string, language = ""): string => {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
};

const languageOf = (received: Received): string => (received.mediaType === "application/json" ? "json" : "");

/** Whether `byte` is a UTF-8 continuation byte (10xxxxxx): a byte inside a character, not its first. */
const continues = (byte: number): boolean => (byte & 0xc0) === 0x80;

/** Returns `at`, or the nearest position before it that is not inside a character, so a cut there splits no character. */
const cutBefore = (bytes: Uint8Array, at: number): number => (at > 0 && continues(bytes[at] ?? 0) ? cutBefore(bytes, at - 1) : at);

/**
 * Returns a tool's output or error as Markdown: text is fenced and cut at `shownOutputBytes` (never
 * inside a character), followed by a line giving the number of bytes omitted; bytes are named, not
 * read.
 */
const toolContent = (received: Received): string => {
  if (received.body._tag !== "Text") return asText(received);
  const bytes = encoder.encode(received.body.text);
  if (bytes.length <= shownOutputBytes) return fenced(received.body.text, languageOf(received));
  const cut = cutBefore(bytes, shownOutputBytes);
  const left = bytes.length - cut;
  return `${fenced(decoder.decode(bytes.subarray(0, cut)), languageOf(received))}\n\n_Cut at 8 KiB: ${left} bytes more were left out._`;
};

/** Returns a model's name as the transcript shows it. */
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

/** Returns the permission question asked before a call ran, and its answer, in one line. */
const permission = (asked: Received, answered: Received | undefined, failed: FailureText | undefined): string => {
  const question = questionIn(asked);
  const asks = question === undefined ? `Permission asked: ${asText(asked)}` : `Permission asked (${question.options.map((option) => option.name).join(" / ")})`;
  if (failed !== undefined) return `${asks}; it could not be asked: ${failed}`;
  if (answered === undefined) return `${asks}; no answer is recorded.`;
  if (answerIn(answered)?.outcome === "cancelled") return `${asks}; cancelled before an answer.`;
  const option = question === undefined ? undefined : optionPicked(question, answered);
  return `${asks}; answered: ${option === undefined ? asText(answered) : option.name}.`;
};

/** Returns how a turn that did not end with an answer ended; nothing for a turn that did. */
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

/** What the facts record of each call and input, by call id or sequence number, for lookup while reading the facts. */
interface Index {
  readonly inputs: ReadonlyMap<Seq, Observed<"InputArrived">>;
  readonly changes: ReadonlyMap<Seq, Observed<"ModelChangeArrived">>;
  readonly asked: ReadonlyMap<CallId, Received>;
  readonly answered: ReadonlyMap<CallId, Received>;
  readonly failed: ReadonlyMap<CallId, FailureText>;
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
    failed: new Map(each("PermissionFailed").map(({ observation }) => [observation.call, observation.problem])),
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
    ...(asked === undefined ? [] : [permission(asked, index.answered.get(call.call), index.failed.get(call.call))]),
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

/** Returns the models that the session asked, in order: the opening model, then each change taken. */
const modelsOf = (facts: ReadonlyArray<Fact>, index: Index): ReadonlyArray<{ readonly provider: ProviderName; readonly model: ModelName }> =>
  facts.flatMap((fact) => {
    if (fact._tag === "Observed") return fact.observation._tag === "SessionOpened" ? [{ provider: fact.observation.model.provider, model: fact.observation.model.model }] : [];
    const change = fact.decision._tag === "ModelChangeTaken" ? index.changes.get(fact.decision.change) : undefined;
    return change === undefined ? [] : [{ provider: change.provider, model: change.model }];
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

/** Returns the inputs recorded at the sequence numbers in `inputs`, as the transcript shows them. */
const inputsAt = (index: Index, inputs: ReadonlyArray<Seq>): ReadonlyArray<string> =>
  inputs.flatMap((seq) => {
    const arrived = index.inputs.get(seq);
    return arrived === undefined ? [`_No input is recorded at ${seq}._`] : input(arrived);
  });

/** The state while reading the facts: how many turns have started, and whether the last one has no ending yet. */
interface Walk {
  readonly turns: number;
  readonly running: boolean;
}

const leftRunningNote = "_The turn was left running: no ending is recorded._";

/** Returns the blocks that a decision adds to the transcript, and the state after it. */
const decided = (index: Index, walk: Walk, decision: Decision): readonly [Walk, ReadonlyArray<string>] => {
  switch (decision._tag) {
    case "InputDelivered":
      return [walk, inputsAt(index, decision.inputs)];
    case "InputDropped":
      return [walk, ["_Input given while the turn ran was dropped, as the turn did not end in an answer:_", ...inputsAt(index, decision.inputs)]];
    case "ModelChangeTaken": {
      const change = index.changes.get(decision.change);
      return [walk, change === undefined ? [] : [`_From here the session asks ${named(change.provider, change.model)}._`]];
    }
    case "TurnEnded":
      return [{ ...walk, running: false }, ending(decision.ending)];
    // These decisions direct what the core does next; the transcript shows their results instead.
    case "TurnCompleted":
    case "TurnIncomplete":
    case "AskModel":
    case "TellModel":
    case "WindowOpened":
    case "ObservationNotExpected":
    case "ObservationUndelivered":
      return [walk, []];
    default:
      return decision satisfies never;
  }
};

/** Returns the blocks that an observation adds to the transcript, and the state after it. */
const observed = (
  index: Index,
  models: ReadonlyArray<{ readonly provider: ProviderName; readonly model: ModelName }>,
  walk: Walk,
  observation: Observation,
): readonly [Walk, ReadonlyArray<string>] => {
  switch (observation._tag) {
    case "SessionOpened":
      return [
        walk,
        [`# Session \`${observation.session}\``, `${models.length > 1 ? "Models" : "Model"}: ${models.map(({ provider, model }) => named(provider, model)).join(", then ")}`],
      ];
    case "TurnStarted":
      // A turn that started before this one and has no ending was left running.
      return [{ turns: walk.turns + 1, running: true }, [...(walk.running ? [leftRunningNote] : []), `## Turn ${walk.turns + 1}`]];
    case "ModelResponded":
      return [walk, response(index, observation)];
    case "ToolCallArrived":
      // A call whose response was recorded is shown with the response.
      return [walk, index.responded.has(observation.call) ? [] : ["### Assistant", ...toolCall(index, observation)]];
    // Inputs are shown where they are delivered, permission and outcomes with their call, the model changes where they are taken.
    case "InputArrived":
    case "ModelChangeArrived":
    case "PermissionAsked":
    case "PermissionAnswered":
    case "PermissionFailed":
    case "ToolEnded":
    // These observations are not part of the conversation.
    case "CompactionWindow":
    case "InputCancelled":
    case "McpServerChanged":
    case "FolderAdded":
    case "ModelRequestDispatched":
    case "ModelFailed":
    case "ModelAttemptFailed":
    case "NoticeInserted":
    case "SettingAdjusted":
    case "ModelVetoed":
    case "ToolCallDispatched":
    case "TurnEndReviewed":
    case "TurnHoldsExhausted":
    case "TurnInterrupted":
      return [walk, []];
    default:
      return observation satisfies never;
  }
};

/**
 * Returns the transcript of the session that `facts` hold, as Markdown: a heading with the session
 * and the models it asked; each turn in order, with its inputs, the model's answer text, its
 * thinking in a collapsed block, each tool call with its input, permission question and outcome, and
 * how the turn ended when it did not end with an answer (or that it was left running); then the
 * totals.
 */
export function markdownOf(facts: ReadonlyArray<Fact>): string {
  const index = indexOf(facts);
  const models = modelsOf(facts, index);
  const [walk, blocks] = Arr.mapAccum(facts, { turns: 0, running: false } satisfies Walk as Walk, (current, fact) =>
    fact._tag === "Decided" ? decided(index, current, fact.decision) : observed(index, models, current, fact.observation),
  );
  return `${[...blocks.flat(), ...(walk.running ? [leftRunningNote] : []), ...footer(facts, models)].join("\n\n")}\n`;
}
