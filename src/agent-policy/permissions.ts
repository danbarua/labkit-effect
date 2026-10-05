/**
 * Permission to run a tool call, as Claude Code's permission modes give it. A call to a tool that
 * only reads (its kind is `read`, `search`, `think` or `fetch`) runs. A call to a tool that changes
 * things runs, is vetoed, or waits for a person's answer, by the mode:
 *
 * - `default`: asks.
 * - `acceptEdits`: a tool that edits, deletes or moves files runs; others ask.
 * - `dontAsk`: is vetoed.
 * - `bypassPermissions`: runs.
 *
 * What is asked offers three options, by ACP's kinds: allow this call (`allow_once`), allow the tool
 * for the rest of the session (`allow_always`), or reject this call (`reject_once`). Allowing a tool
 * for the session is an answer in the session's facts: a later call to that tool runs without being
 * asked, in any mode, in this process or one that goes on from the facts.
 *
 * Where there is no one to answer (`canAsk` false: print mode), what would be asked is vetoed. The
 * veto's reason names the permission modes that let the call run: `acceptEdits` or
 * `bypassPermissions` for a tool that edits, deletes or moves files; `bypassPermissions` for any
 * other tool.
 */

import { Schema } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import { FailureText, ToolKind, ToolName } from "../agent-machine/names.ts";
import { MediaType, type Received, ReceivedText } from "../agent-machine/received.ts";
import type { Policy, PolicyStep } from "./policy.ts";

export const PermissionMode = Schema.Literals(["default", "acceptEdits", "dontAsk", "bypassPermissions"]);
export type PermissionMode = typeof PermissionMode.Type;

/** The id of an option offered, which the answer names. */
export const OptionId = Schema.String.pipe(Schema.brand("agent-policy/OptionId"));
export type OptionId = typeof OptionId.Type;

/** An option as it is shown to whoever answers. */
export const OptionName = Schema.String.pipe(Schema.brand("agent-policy/OptionName"));
export type OptionName = typeof OptionName.Type;

export const PermissionOption = Schema.Struct({
  optionId: OptionId,
  name: OptionName,
  kind: Schema.Literals(["allow_once", "allow_always", "reject_once", "reject_always"]),
});
export type PermissionOption = typeof PermissionOption.Type;

/**
 * What is asked before a call runs (`PermissionAsked.asks`): the call's tool, its kind, and the
 * options. The call's input is in the facts, with the call.
 */
export const PermissionQuestion = Schema.Struct({
  tool: ToolName,
  kind: ToolKind,
  options: Schema.Array(PermissionOption),
});
export type PermissionQuestion = typeof PermissionQuestion.Type;

/** The answer (`PermissionAnswered.answer`): the option picked. */
export const PermissionAnswer = Schema.Struct({ optionId: OptionId });
export type PermissionAnswer = typeof PermissionAnswer.Type;

const json = MediaType.make("application/json");

/** `value` as JSON content, as `PermissionAsked` and `PermissionAnswered` hold it. */
const asJson = <S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }>(schema: S, value: S["Type"]): Received => ({
  mediaType: json,
  body: { _tag: "Text", text: ReceivedText.make(Schema.encodeSync(Schema.fromJsonString(schema))(value)) },
});

/** The value of `schema` in `received`, when it holds one. */
const fromJson = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, received: Received): S["Type"] | undefined => {
  if (received.body._tag !== "Text") return undefined;
  const text: unknown = received.body.text;
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text);
  return decoded._tag === "Some" ? decoded.value : undefined;
};

/** The question in a `PermissionAsked`, when it is one this module asked. */
export const questionIn = (asks: Received): PermissionQuestion | undefined => fromJson(PermissionQuestion, asks);

/** The answer that picks `option`, as `PermissionAnswered` holds it. */
export const answerPicking = (option: OptionId): Received => asJson(PermissionAnswer, { optionId: option });

/** The option an answer picked among the question's, when it names one of them. */
const pickedIn = (question: PermissionQuestion, answer: Received): PermissionOption | undefined => {
  const picked = fromJson(PermissionAnswer, answer);
  return picked === undefined ? undefined : question.options.find((option) => option.optionId === picked.optionId);
};

const onlyReads: ReadonlyArray<ToolKind> = ["read", "search", "think", "fetch"];
const editsFiles: ReadonlyArray<ToolKind> = ["edit", "delete", "move"];

const optionsFor = (tool: ToolName): ReadonlyArray<PermissionOption> => [
  { optionId: OptionId.make("allow-once"), name: OptionName.make("Allow once"), kind: "allow_once" },
  { optionId: OptionId.make("allow-session"), name: OptionName.make(`Allow ${tool} for the rest of the session`), kind: "allow_always" },
  { optionId: OptionId.make("reject-once"), name: OptionName.make("Reject"), kind: "reject_once" },
];

/** Whether an earlier answer in `facts` allowed `tool` for the session, or rejected it for the session. */
function rememberedFor(facts: ReadonlyArray<Fact>, tool: ToolName): "allowed" | "rejected" | undefined {
  const asked = new Map(
    facts.flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "PermissionAsked" ? [[fact.observation.call, fact.observation.asks] as const] : [],
    ),
  );
  return facts.reduce<"allowed" | "rejected" | undefined>((remembered, fact) => {
    if (fact._tag !== "Observed" || fact.observation._tag !== "PermissionAnswered") return remembered;
    const asks = asked.get(fact.observation.call);
    const question = asks === undefined ? undefined : questionIn(asks);
    if (question === undefined || question.tool !== tool) return remembered;
    const picked = pickedIn(question, fact.observation.answer);
    return picked?.kind === "allow_always" ? "allowed" : picked?.kind === "reject_always" ? "rejected" : remembered;
  }, undefined);
}

const proceed: PolicyStep<PermissionQuestion> = { _tag: "Decided", verdict: { _tag: "Continue" } };
const veto = (reason: FailureText): PolicyStep<PermissionQuestion> => ({
  _tag: "Decided",
  verdict: { _tag: "Veto", reason: { mediaType: MediaType.make("text/plain"), body: { _tag: "Text", text: ReceivedText.make(reason) } } },
});

/**
 * The permission policy for a session in `mode`, as `facts` stand, with what is known of each
 * tool's kind (`kindOf`; a tool not known is `other`). `canAsk` is whether anyone is there to answer.
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
      if (onlyReads.includes(kind) || mode === "bypassPermissions") return proceed;
      if (mode === "acceptEdits" && editsFiles.includes(kind)) return proceed;
      const remembered = rememberedFor(facts, request.tool);
      if (remembered === "allowed") return proceed;
      if (remembered === "rejected") return veto(FailureText.make(`${request.tool} was rejected for the rest of the session.`));
      if (mode === "dontAsk") return veto(FailureText.make(`${request.tool} needs permission, and the permission mode is dontAsk.`));
      if (!canAsk) {
        const letting = editsFiles.includes(kind) ? "acceptEdits or bypassPermissions" : "bypassPermissions";
        return veto(FailureText.make(`${request.tool} needs permission, and no one is there to answer. --permission-mode ${letting} lets it run.`));
      }
      const question: PermissionQuestion = { tool: request.tool, kind, options: optionsFor(request.tool) };
      return { _tag: "Waiting", state: question, asks: asJson(PermissionQuestion, question) };
    },
    receive: (question, message) => {
      if (message._tag !== "Answered") return { _tag: "Waiting", state: question, asks: undefined };
      const picked = pickedIn(question, message.answer);
      if (picked === undefined) return veto(FailureText.make(`The answer named no option offered for ${question.tool}.`));
      return picked.kind === "allow_once" || picked.kind === "allow_always"
        ? proceed
        : veto(FailureText.make(`The user rejected this call to ${question.tool}.`));
    },
  };
}
