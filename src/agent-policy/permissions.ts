/**
 * The permission policy, by Claude Code's permission modes. A call to a tool that only reads (kind
 * `read`, `search`, `think` or `fetch`) runs in every mode. Any other call runs, is vetoed, or waits
 * for an answer, by the mode:
 *
 * - `default`: asks.
 * - `acceptEdits`: runs a tool that edits, deletes or moves files; asks about any other tool.
 * - `dontAsk`: vetoes.
 * - `bypassPermissions`: runs.
 *
 * A question offers four options, with ACP's kinds:
 *
 * - `allow_once`: allow this call.
 * - `allow_always`: allow the tool for the rest of the session.
 * - `reject_once`: reject this call.
 * - `reject_always`: reject the tool for the rest of the session.
 *
 * Session answers are read from the session's facts, so they also apply in a process that resumes
 * the session. After `allow_always`, later calls to the tool run without a question, in every mode.
 * After `reject_always`, later calls to the tool are vetoed without a question, in every mode.
 *
 * When no one can answer (`canAsk` is false, as in print mode), a call that would be asked about is
 * vetoed. The veto's reason names the permission modes that let the call run: `acceptEdits` or
 * `bypassPermissions` for a tool that edits, deletes or moves files, and `bypassPermissions` for
 * any other tool.
 */

import { Schema } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import { FailureText, ToolKind, ToolName } from "../agent-machine/names.ts";
import { MediaType, type Received, ReceivedText } from "../agent-machine/received.ts";
import type { Policy, PolicyStep } from "./policy.ts";

export const PermissionMode = Schema.Literals(["default", "acceptEdits", "dontAsk", "bypassPermissions"]);
export type PermissionMode = typeof PermissionMode.Type;

/** The id of an offered option. An answer names the option that it picks by this id. */
export const OptionId = Schema.String.pipe(Schema.brand("agent-policy/OptionId"));
export type OptionId = typeof OptionId.Type;

/** An option's label, as shown to the person who answers. */
export const OptionName = Schema.String.pipe(Schema.brand("agent-policy/OptionName"));
export type OptionName = typeof OptionName.Type;

export const PermissionOption = Schema.Struct({
  optionId: OptionId,
  name: OptionName,
  kind: Schema.Literals(["allow_once", "allow_always", "reject_once", "reject_always"]),
});
export type PermissionOption = typeof PermissionOption.Type;

/**
 * The question asked before a call runs (`PermissionAsked.asks`): the tool, its kind, and the
 * options. The call's input is not repeated here; it is in the facts, with the call.
 */
export const PermissionQuestion = Schema.Struct({
  tool: ToolName,
  kind: ToolKind,
  options: Schema.Array(PermissionOption),
});
export type PermissionQuestion = typeof PermissionQuestion.Type;

/** The answer (`PermissionAnswered.answer`): the id of the option picked. */
export const PermissionAnswer = Schema.Struct({ optionId: OptionId });
export type PermissionAnswer = typeof PermissionAnswer.Type;

const json = MediaType.make("application/json");

/** Encodes `value` as JSON content, the form in which `PermissionAsked` and `PermissionAnswered` hold it. */
const asJson = <S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }>(schema: S, value: S["Type"]): Received => ({
  mediaType: json,
  body: { _tag: "Text", text: ReceivedText.make(Schema.encodeSync(Schema.fromJsonString(schema))(value)) },
});

/** Decodes `received` as JSON of `schema`; returns undefined when it is not. */
const fromJson = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, received: Received): S["Type"] | undefined => {
  if (received.body._tag !== "Text") return undefined;
  const text: unknown = received.body.text;
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text);
  return decoded._tag === "Some" ? decoded.value : undefined;
};

/** Decodes the question in a `PermissionAsked`; returns undefined when this module did not ask it. */
export const questionIn = (asks: Received): PermissionQuestion | undefined => fromJson(PermissionQuestion, asks);

/** Returns the answer that picks `option`, in the form that `PermissionAnswered` holds. */
export const answerPicking = (option: OptionId): Received => asJson(PermissionAnswer, { optionId: option });

/** Returns the question's option that `answer` picks; undefined when the answer names no offered option. */
const optionPicked = (question: PermissionQuestion, answer: Received): PermissionOption | undefined => {
  const picked = fromJson(PermissionAnswer, answer);
  return picked === undefined ? undefined : question.options.find((option) => option.optionId === picked.optionId);
};

const onlyReads: ReadonlyArray<ToolKind> = ["read", "search", "think", "fetch"];
const editsFiles: ReadonlyArray<ToolKind> = ["edit", "delete", "move"];

const optionsFor = (tool: ToolName): ReadonlyArray<PermissionOption> => [
  { optionId: OptionId.make("allow-once"), name: OptionName.make("Allow once"), kind: "allow_once" },
  { optionId: OptionId.make("allow-session"), name: OptionName.make(`Allow ${tool} for the rest of the session`), kind: "allow_always" },
  { optionId: OptionId.make("reject-once"), name: OptionName.make("Reject"), kind: "reject_once" },
  { optionId: OptionId.make("reject-session"), name: OptionName.make(`Reject ${tool} for the rest of the session`), kind: "reject_always" },
];

/** Returns the latest session answer for `tool` in `facts`: allowed, rejected, or undefined when there is none. */
function sessionAnswerFor(facts: ReadonlyArray<Fact>, tool: ToolName): "allowed" | "rejected" | undefined {
  const asked = new Map(
    facts.flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "PermissionAsked" ? [[fact.observation.call, fact.observation.asks] as const] : [],
    ),
  );
  return facts.reduce<"allowed" | "rejected" | undefined>((sessionAnswer, fact) => {
    if (fact._tag !== "Observed" || fact.observation._tag !== "PermissionAnswered") return sessionAnswer;
    const asks = asked.get(fact.observation.call);
    const question = asks === undefined ? undefined : questionIn(asks);
    if (question === undefined || question.tool !== tool) return sessionAnswer;
    const picked = optionPicked(question, fact.observation.answer);
    return picked?.kind === "allow_always" ? "allowed" : picked?.kind === "reject_always" ? "rejected" : sessionAnswer;
  }, undefined);
}

const proceed: PolicyStep<PermissionQuestion> = { _tag: "Decided", verdict: { _tag: "Continue" } };
const veto = (reason: FailureText): PolicyStep<PermissionQuestion> => ({
  _tag: "Decided",
  verdict: { _tag: "Veto", reason: { mediaType: MediaType.make("text/plain"), body: { _tag: "Text", text: ReceivedText.make(reason) } } },
});

/**
 * Returns the permission policy for a session in `mode`, as `facts` stand. `kindOf` returns a tool's
 * kind; a tool that it does not know is treated as `other`. `canAsk` is whether anyone can answer a
 * question.
 */
export function permissions(
  mode: PermissionMode,
  canAsk: boolean,
  kindOf: (tool: ToolName) => ToolKind | undefined,
  facts: ReadonlyArray<Fact>,
): Policy<PermissionQuestion> {
  return {
    start: (request) => {
      if (request._tag !== "RunTool") return proceed;
      const kind = kindOf(request.tool) ?? "other";
      if (onlyReads.includes(kind)) return proceed;
      const sessionAnswer = sessionAnswerFor(facts, request.tool);
      // A session rejection applies in every mode, so it is checked before the mode.
      if (sessionAnswer === "rejected") return veto(FailureText.make(`${request.tool} was rejected for the rest of the session.`));
      if (mode === "bypassPermissions") return proceed;
      if (mode === "acceptEdits" && editsFiles.includes(kind)) return proceed;
      if (sessionAnswer === "allowed") return proceed;
      if (mode === "dontAsk") return veto(FailureText.make(`${request.tool} needs permission, and the permission mode is dontAsk.`));
      if (!canAsk) {
        const allowingModes = editsFiles.includes(kind) ? "acceptEdits or bypassPermissions" : "bypassPermissions";
        return veto(FailureText.make(`${request.tool} needs permission, and no one is there to answer. --permission-mode ${allowingModes} lets it run.`));
      }
      const question: PermissionQuestion = { tool: request.tool, kind, options: optionsFor(request.tool) };
      return { _tag: "Waiting", state: question, asks: asJson(PermissionQuestion, question) };
    },
    receive: (question, message) => {
      if (message._tag !== "Answered") return { _tag: "Waiting", state: question, asks: undefined };
      const picked = optionPicked(question, message.answer);
      if (picked === undefined) return veto(FailureText.make(`The answer named no option offered for ${question.tool}.`));
      return picked.kind === "allow_once" || picked.kind === "allow_always"
        ? proceed
        : veto(FailureText.make(`The user rejected this call to ${question.tool}.`));
    },
  };
}
