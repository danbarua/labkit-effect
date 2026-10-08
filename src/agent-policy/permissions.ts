/**
 * The permission policy, by Claude Code's permission modes, by allow and deny rules, and, for a tool
 * that runs shell commands, by each program the command runs.
 *
 * **A call to a tool that does not run shell commands** is judged by the tool's kind. A call to a
 * tool that only reads (kind `read`, `search`, `think` or `fetch`) runs in every mode. Any other
 * call, by the mode:
 *
 * - `default`: asks.
 * - `acceptEdits`: runs a tool that edits, deletes or moves files; asks about any other tool.
 * - `dontAsk`: vetoes.
 * - `bypassPermissions`: runs.
 *
 * Its question offers four options, with ACP's kinds: `allow_once` (this call), `allow_always` (the
 * tool, for the rest of the session), `reject_once`, and `reject_always` (the tool, for the rest of
 * the session).
 *
 * **A call to a command tool** (`commandTools`; its input's `command` is a shell command) is judged by
 * the programs its command runs (`command-units.ts`), when the policy is given a command parser
 * (`commands`; otherwise it is judged by its kind, as any tool). A program runs without a question
 * when an allow rule names it, a read-only prefix names it (`readOnly`), or the session has allowed
 * its grant. A program whose words do not show what it runs (it is opaque) runs without a question
 * only when an allow rule names it. A program that writes files (a redirect, `tee`) needs the
 * `acceptEdits` mode as well. A program that reads outside the working folder (an absolute path, one
 * through `..` or `~`, or one not written out) needs permission unless an allow rule names it, even
 * when it is read-only or its grant is allowed. A command that cannot be split is asked about. When every program
 * runs without a question, the call runs; otherwise, by the mode:
 *
 * - `default` and `acceptEdits`: asks, naming each program that needs permission and why.
 * - `dontAsk`: vetoes, naming them.
 * - `bypassPermissions`: runs.
 *
 * Its question offers `allow_once` and `reject_once`; and, when everything it asks about is a program
 * that is not allowed yet and has a grant, `allow_always` and `reject_always` for those grants
 * (`git log`, `bun test`) for the rest of the session.
 *
 * **Rules** (`permission-rules.ts`) apply in every mode: a deny rule that names the tool, or one of its
 * command's programs, vetoes the call; an allow rule that names the tool runs it without a question.
 *
 * **Session answers** are read from the session's facts, so they apply in a process that resumes the
 * session too, and in every mode: `dontAsk` and print mode are autonomy, not a reason to forget what
 * the user allowed. A session rejection vetoes in every mode, `bypassPermissions` included.
 *
 * When no one can answer (`canAsk` is false, as in print mode), a call that would be asked about is
 * vetoed. The veto's reason names the permission modes that let the call run.
 */

import { codeSpan } from "./code-span.ts";
import { Schema } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import { FailureText, ToolKind, ToolName } from "../agent-machine/names.ts";
import { MediaType, type Received, ReceivedText } from "../agent-machine/received.ts";
import { type SegmentsOf, ShellCommand, type Word, WordText } from "./command-segments.ts";
import { commandNotes, notesOf } from "./command-explainers.ts";
import { Detail, type Folders, NeedText, type OutsideChange, placesOf, relativePath, type Unit, type UnitPath, unitsOf } from "./command-units.ts";
import { Explanation } from "./sed-script.ts";
import { defaultReadOnly, namesProgram, namesTool, type ParsedRule, parseRule, type PathRule, pathRuleOf, PermissionRule, type ReadOnlyPrefix, readOnlyNames, ruleNamesProgram } from "./permission-rules.ts";
import { changeReaches, matchesPath } from "./path-patterns.ts";
import { leavesFolder, resolvePath } from "./path-resolver.ts";
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
 * Why a program needs permission, and what else lets it run without a question. `bypassPermissions`,
 * and an allow rule for the whole tool, let every kind run except `unseen`.
 *
 * | Kind | Why | What else lets it run |
 * | --- | --- | --- |
 * | `notAllowed` | it is not allowed yet | an allow rule naming it, a read-only prefix, or its grant allowed for the session |
 * | `opaque` | its words do not show what it runs | an allow rule naming it |
 * | `writes` | it writes files inside the working folder | `acceptEdits`, or an `Edit` rule matching the files |
 * | `readsOutside` | it reads outside the working folder | a `Read` or `Edit` rule matching the paths |
 * | `changesOutside` | it writes, deletes, moves or changes paths outside the working folder | an `Edit` rule matching the paths |
 * | `unseen` | deny rules cannot see what it runs | nothing |
 * | `unparsed` | the command does not parse, or the call has no command | nothing |
 */
export const NeedKind = Schema.Literals(["notAllowed", "opaque", "writes", "readsOutside", "changesOutside", "unseen", "unparsed"]);
export type NeedKind = typeof NeedKind.Type;

/** What a command needs before it runs: one of its programs, as written, and why it needs permission (its kind, and as shown). */
export const CommandNeed = Schema.Struct({ program: WordText, kind: NeedKind, why: NeedText });
export type CommandNeed = typeof CommandNeed.Type;

/** A grant, as a question offers it and an answer records it: the words that a session allows or rejects (`git log`). */
export const Grant = Schema.Array(WordText);
export type Grant = typeof Grant.Type;

/**
 * The question asked before a call runs (`PermissionAsked.asks`): about a tool (`Tool`: the tool, its
 * kind and the options), or about a command (`Command`: also the command, what it needs, and the
 * grants that the session options name). A call's input is not repeated in a tool's question; it is
 * in the facts, with the call.
 */
export const PermissionQuestion = Schema.Union([
  Schema.TaggedStruct("Tool", {
    tool: ToolName,
    kind: ToolKind,
    options: Schema.Array(PermissionOption),
    /** Why the call needs permission when it is not its kind alone: it reads or changes a path outside the working folder. */
    why: Schema.optionalKey(NeedText),
  }),
  Schema.TaggedStruct("Command", {
    tool: ToolName,
    kind: ToolKind,
    options: Schema.Array(PermissionOption),
    command: ShellCommand,
    needs: Schema.Array(CommandNeed),
    grants: Schema.Array(Grant),
  }),
]);
export type PermissionQuestion = typeof PermissionQuestion.Type;

/**
 * What a question about a command shows besides why each program needs permission: for each program,
 * what helps the person judge it (`detail`: what a `sed` script does, the code a runtime is given, the
 * text written to a file) and plain-English notes (`command-explainers.ts`); and the notes about the
 * command as a whole. It is worked out from the question's command when the question is shown, not
 * stored with it: the command is the fact, and better explanations apply to past questions too.
 */
export interface Explained {
  readonly programs: ReadonlyArray<{ readonly program: WordText; readonly detail: Detail | undefined; readonly notes: ReadonlyArray<Explanation> }>;
  readonly notes: ReadonlyArray<Explanation>;
}

/** What `question` shows besides its needs, judged against `folders`; `segmentsOf` is the host's parser. */
export const explainedOf = (question: Extract<PermissionQuestion, { readonly _tag: "Command" }>, segmentsOf: SegmentsOf, folders: Folders | undefined): Explained => {
  const split = unitsOf(question.command, segmentsOf, folders);
  const units = split._tag === "Units" ? split.units : [];
  return {
    programs: units.map((unit) => ({ program: programOf(unit), detail: unit.detail, notes: notesOf(unit, folders) })).filter((each) => each.detail !== undefined || each.notes.length > 0),
    notes: commandNotes(question.command, segmentsOf, question.grants),
  };
};

/** The detail and notes to show under the need at `at` in `needs`: its program's, on the first need that names the program; none on the others. */
export const explainedAt = (explained: Explained, needs: ReadonlyArray<CommandNeed>, at: number): Explained["programs"][number] | undefined => {
  const need = needs[at];
  if (need === undefined || needs.findIndex((each) => each.program === need.program) !== at) return undefined;
  return explained.programs.find((each) => each.program === need.program);
};

/**
 * The answer (`PermissionAnswered.answer`), as ACP's `RequestPermissionOutcome` gives it: the option
 * selected, by its id, or `cancelled`, which the answerer gives when the turn that asked was cancelled.
 * An answer recorded as `{ optionId }` alone, without `outcome`, selected that option.
 */
export const PermissionAnswer = Schema.Union([
  Schema.Struct({ outcome: Schema.optionalKey(Schema.Literal("selected")), optionId: OptionId }),
  Schema.Struct({ outcome: Schema.Literal("cancelled") }),
]);
export type PermissionAnswer = typeof PermissionAnswer.Type;

/** How commands are judged: the rules and read-only programs, which tools run shell commands, and the parser that splits a command. */
export interface PermissionSettings {
  readonly allow: ReadonlyArray<PermissionRule>;
  readonly deny: ReadonlyArray<PermissionRule>;
  readonly readOnly: ReadonlyArray<ReadOnlyPrefix>;
  readonly commandTools: ReadonlyArray<ToolName>;
}

/** The settings when the configuration gives none: no rules, the default read-only programs, and the CLI's and the ACP host's command tools. */
export const defaultPermissionSettings: PermissionSettings = {
  allow: [],
  deny: [],
  readOnly: defaultReadOnly,
  commandTools: [ToolName.make("run_command"), ToolName.make("terminal_command")],
};

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

/** Returns the answer that selects `option`, in the form that `PermissionAnswered` holds. */
export const answerPicking = (option: OptionId): Received => asJson(PermissionAnswer, { outcome: "selected", optionId: option });

/** The answer `cancelled`, in the form that `PermissionAnswered` holds. */
export const answerCancelled: Received = asJson(PermissionAnswer, { outcome: "cancelled" });

/** Decodes the answer in a `PermissionAnswered`; returns undefined when it is not one that this module reads. */
export const answerIn = (answer: Received): PermissionAnswer | undefined => fromJson(PermissionAnswer, answer);

/** Returns the question's option that `answer` selects; undefined when the answer is `cancelled` or names no offered option. */
export const optionPicked = (question: PermissionQuestion, answer: Received): PermissionOption | undefined => {
  const picked = answerIn(answer);
  return picked === undefined || !("optionId" in picked) ? undefined : question.options.find((option) => option.optionId === picked.optionId);
};

/** A command's input, as the command tools take it: `{ "command": … }`. */
const CommandInput = Schema.Struct({ command: ShellCommand });

/** Returns the shell command in a command tool's `input`; undefined when the input has none. */
const commandIn = (input: Received): ShellCommand | undefined => fromJson(CommandInput, input)?.command;

const onlyReads: ReadonlyArray<ToolKind> = ["read", "search", "think", "fetch"];
/** What a tool of each kind that changes files does to its paths; any other kind writes them. */
const changeByKind: ReadonlyMap<ToolKind, UnitPath["access"]> = new Map<ToolKind, UnitPath["access"]>([
  ["delete", "deletes"],
  ["move", "moves"],
]);
/** The kinds of tool that change files: they run unasked in `acceptEdits`, and what they change is recorded (`agent-host/recorded-changes.ts`). */
export const editsFiles: ReadonlyArray<ToolKind> = ["edit", "delete", "move"];

const option = (id: Parameters<typeof OptionId.make>[0], name: Parameters<typeof OptionName.make>[0], kind: PermissionOption["kind"]): PermissionOption => ({
  optionId: OptionId.make(id),
  name: OptionName.make(name),
  kind,
});

const toolOptions = (tool: ToolName): ReadonlyArray<PermissionOption> => [
  option("allow-once", "Allow once", "allow_once"),
  option("allow-session", `Allow ${tool} for the rest of the session`, "allow_always"),
  option("reject-once", "Reject", "reject_once"),
  option("reject-session", `Reject ${tool} for the rest of the session`, "reject_always"),
];

const shownGrant = (grant: Grant): WordText => WordText.make(grant.join(" "));

/** `items` as one phrase: `a`, `a and b`, `a, b and c`; past three, the first three and how many more. */
/** `word` as a Markdown code span, for a reason that names a program or a path (`codeSpan`). */
const coded = (word: WordText): WordText => WordText.make(codeSpan(word));

const listed = (items: ReadonlyArray<WordText>): WordText => {
  const shown = items.length > 3 ? [...items.slice(0, 3), WordText.make(`${items.length - 3} more`)] : items;
  return WordText.make(shown.length <= 1 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1) ?? ""}`);
};

const commandOptions = (grants: ReadonlyArray<Grant>): ReadonlyArray<PermissionOption> => {
  const named = listed(grants.map(shownGrant));
  return grants.length === 0
    ? [option("allow-once", "Allow once", "allow_once"), option("reject-once", "Reject", "reject_once")]
    : [
        option("allow-once", "Allow once", "allow_once"),
        option("allow-session", `Allow ${named} for the rest of the session`, "allow_always"),
        option("reject-once", "Reject", "reject_once"),
        option("reject-session", `Reject ${named} for the rest of the session`, "reject_always"),
      ];
};

const sameGrant = (one: Grant, other: Grant): boolean => one.length === other.length && one.every((word, at) => word === other[at]);

/** What the session has answered for `tool`: the tool allowed or rejected, and the grants allowed and rejected. */
interface SessionAnswers {
  readonly tool: "allowed" | "rejected" | undefined;
  readonly allowed: ReadonlyArray<Grant>;
  readonly rejected: ReadonlyArray<Grant>;
}

/** Returns the session's answers for `tool` in `facts`; a later answer for a tool or grant replaces an earlier one. */
function sessionAnswersFor(facts: ReadonlyArray<Fact>, tool: ToolName): SessionAnswers {
  const asked = new Map(
    facts.flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "PermissionAsked" ? [[fact.observation.call, fact.observation.asks] as const] : [],
    ),
  );
  return facts.reduce<SessionAnswers>(
    (answers, fact) => {
      if (fact._tag !== "Observed" || fact.observation._tag !== "PermissionAnswered") return answers;
      const asks = asked.get(fact.observation.call);
      const question = asks === undefined ? undefined : questionIn(asks);
      if (question === undefined || question.tool !== tool) return answers;
      const picked = optionPicked(question, fact.observation.answer)?.kind;
      if (picked !== "allow_always" && picked !== "reject_always") return answers;
      if (question._tag === "Tool") return { ...answers, tool: picked === "allow_always" ? "allowed" : "rejected" };
      const without = (grants: ReadonlyArray<Grant>) => grants.filter((grant) => !question.grants.some((answered) => sameGrant(grant, answered)));
      return picked === "allow_always"
        ? { ...answers, allowed: [...without(answers.allowed), ...question.grants], rejected: without(answers.rejected) }
        : { ...answers, allowed: without(answers.allowed), rejected: [...without(answers.rejected), ...question.grants] };
    },
    { tool: undefined, allowed: [], rejected: [] },
  );
}

const proceed: PolicyStep<PermissionQuestion> = { _tag: "Decided", verdict: { _tag: "Continue" } };
const veto = (reason: Parameters<typeof FailureText.make>[0]): PolicyStep<PermissionQuestion> => ({
  _tag: "Decided",
  verdict: { _tag: "Veto", reason: { mediaType: MediaType.make("text/plain"), body: { _tag: "Text", text: ReceivedText.make(FailureText.make(reason)) } } },
});
const ask = (question: PermissionQuestion): PolicyStep<PermissionQuestion> => ({ _tag: "Waiting", state: question, asks: asJson(PermissionQuestion, question) });

/** A unit as the question shows it: its words as written; for a unit with no program, the redirect. */
const programOf = (unit: Unit): WordText => WordText.make(unit.words.length === 0 ? "a redirect" : unit.words.map((word) => word.text).join(" "));

/** Whether a deny rule names `unit`'s program; for an opaque unit, anywhere among its words (`sudo rm`). */
const denies = (rule: ParsedRule, unit: Unit): boolean =>
  unit.opaque === undefined ? ruleNamesProgram(rule, unit, true) : unit.words.some((_, at) => rule.words !== undefined && namesProgram(rule.words, rule.prefix, { ...unit, words: unit.words.slice(at) }, true));

/** The judging of command tools' calls: the settings, the parser that splits a command, and the folders that paths are judged against (without them, every absolute path and `~` is outside). */
export interface CommandJudging {
  readonly settings: PermissionSettings;
  readonly segmentsOf: SegmentsOf;
  readonly folders?: Folders;
  /** The names of a tool's inputs that are paths (`ToolSpec.paths`): a call's paths are judged as a command's are. */
  readonly pathInputsOf?: (tool: ToolName) => ReadonlyArray<Parameters<typeof WordText.make>[0]>;
}

/**
 * The path rules of `judging`'s settings, applied to each unit's paths (`UnitPath`), each resolved
 * against the folders a relative path may be in at that unit (`path-resolver.ts`):
 * - a `cd` or `pushd` to a folder written out adds it, since the command may or may not have moved
 *   by then; after a `popd`, a `cd -`, or a `cd` to a folder not written out, where a relative path
 *   leads is not known;
 * - `deniedBy`: the deny rule a path is refused by (`covers`): a read by a `Read(...)` rule it
 *   matches, or whose paths a recursive read reaches; a change by a `Read(...)` or `Edit(...)` rule
 *   whose paths it reaches (`changeReaches`: `rm -rf ~` reaches `~/.ssh/**`);
 * - `unseen`: why the deny rules that cover the path cannot see it: not written out, another user's home
 *   folder, a glob (`.en*`), after a move it cannot follow, or given as the program runs (`xargs`,
 *   `find -exec`);
 * - `allows`: whether an allow rule matches the path in every folder it may be in: a read by a
 *   `Read(...)` or an `Edit(...)` rule (an allowed edit is an allowed read), a change by an `Edit(...)`
 *   rule;
 * - `leaves`: whether a path may lead outside the working folder, in any folder it may be in.
 */
/**
 * Whether deny rule `rule` covers a path accessed as `access`: a `Read(...)` rule covers every
 * access, since a path that may not be read may not be changed either; an `Edit(...)` rule covers
 * changes only.
 */
const covers = (rule: PathRule, access: UnitPath["access"]): boolean => rule.access === "read" || access !== "reads";

/** Why `subject` is refused by the path rule `rule` for a path accessed as `access`; a `Read(...)` rule refusing a change says that it covers changes. */
const deniedByPath = (subject: WordText | ToolName, rule: PathRule, access: UnitPath["access"]) =>
  `${subject} is denied by the rule ${rule.rule}${rule.access === "read" && access !== "reads" ? ": a path that may not be read may not be changed either" : ""}`;

const pathJudging = (judging: CommandJudging, units: ReadonlyArray<Unit>) => {
  const folders = judging.folders;
  const allow = judging.settings.allow.flatMap((rule) => present(pathRuleOf(rule)));
  const deny = judging.settings.deny.flatMap((rule) => present(pathRuleOf(rule)));
  const relative = relativePath;
  const placed = placesOf(units, folders);
  const basesAt = (word: Word, at: number): ReadonlyArray<WordText | undefined> => (relative(word) ? (placed[at]?.bases ?? [undefined]) : [undefined]);
  const fullsOf = (word: Word, at: number): ReadonlyArray<WordText | undefined> =>
    basesAt(word, at).map((base) => {
      const resolved = resolvePath(word, folders, base);
      return resolved._tag === "Local" ? resolved.full : undefined;
    });
  const isGlob = (word: Word): boolean => /[*?[]/.test(word.literal ?? word.text);
  return {
    deny,
    leaves: (word: Word, at: number): boolean => basesAt(word, at).some((base) => leavesFolder(word, folders, base)) || (relative(word) && placed[at]?.unknown === true),
    deniedBy: (path: UnitPath, at: number): PathRule | undefined => {
      if (path.word === undefined || folders === undefined) return undefined;
      const fulls = fullsOf(path.word, at).flatMap((full) => present(full));
      const reached = (rule: PathRule) => fulls.some((full) => (path.access === "reads" && path.recursive !== true ? matchesPath(rule.pattern, full, folders) : changeReaches(rule.pattern, full, folders)));
      return deny.find((rule) => covers(rule, path.access) && reached(rule));
    },
    unseen: (path: UnitPath, at: number): NeedText | undefined => {
      if (!deny.some((rule) => covers(rule, path.access))) return undefined;
      const verb = path.access;
      if (path.word === undefined) return NeedText.make(`deny rules cannot see which files it ${verb}: ${codeSpan(path.givenBy === "find" ? "find" : "xargs")} gives them as it runs`);
      const resolved = resolvePath(path.word, folders);
      if (resolved._tag === "Unresolved") return NeedText.make(`deny rules cannot see which file it ${verb}: ${codeSpan(path.word.text)} is ${resolved.why === "not written out" ? "not written out" : "in another user's home folder"}`);
      if (isGlob(path.word)) return NeedText.make(`deny rules cannot see which files it ${verb}: ${codeSpan(path.word.text)} is a pattern`);
      if (relative(path.word) && placed[at]?.unknown === true) return NeedText.make(`deny rules cannot see which file it ${verb}: a ${codeSpan("cd")} earlier in the command moves where ${codeSpan(path.word.text)} leads`);
      return resolved.full === undefined || folders === undefined ? NeedText.make(`deny rules cannot see which file it ${verb}: the working folder is not known`) : undefined;
    },
    allows: (path: UnitPath, at: number): boolean => {
      if (path.word === undefined || folders === undefined || (relative(path.word) && placed[at]?.unknown === true)) return false;
      const fulls = fullsOf(path.word, at);
      return fulls.every((full) => full !== undefined && allow.some((rule) => (path.access === "reads" || rule.access === "edit") && matchesPath(rule.pattern, full, folders)));
    },
  };
};

const present = <A>(value: A | undefined): ReadonlyArray<A> => (value === undefined ? [] : [value]);
const wordText = (word: Word): WordText => word.literal ?? word.text;

/**
 * The paths a call to `tool` names in its path inputs (`CommandJudging.pathInputsOf`), judged against
 * the path rules and the working folders: why one is refused by a deny rule (a read by `Read(...)`, a
 * change by `Read(...)` or `Edit(...)`, as `kind` says which it is), and why the call needs permission when one is
 * outside the folders and no path allow rule matches it.
 */
const toolPaths = (input: Received, tool: ToolName, kind: ToolKind, judging: CommandJudging): { readonly denied: ReturnType<typeof deniedByPath> | undefined; readonly outside: NeedText | undefined } => {
  const names = judging.pathInputsOf?.(tool) ?? [];
  const given = fromJson(Schema.Record(WordText, Schema.Unknown), input) ?? {};
  const words = names.flatMap((name) => {
    const value = given[WordText.make(name)];
    return typeof value === "string" && value !== "" ? [{ text: WordText.make(value), literal: WordText.make(value) }] : [];
  });
  const access: UnitPath["access"] = onlyReads.includes(kind) ? "reads" : (changeByKind.get(kind) ?? "writes");
  const unitsOfPaths: ReadonlyArray<Unit> = [{ words: [], grant: undefined, writes: [], changesOutside: [], opaque: undefined, outside: [], paths: words.map((word) => ({ access, word })), detail: undefined }];
  const judged = pathJudging(judging, unitsOfPaths);
  const rule = words.map((word) => judged.deniedBy({ access, word }, 0)).find((each) => each !== undefined);
  const denied = rule === undefined ? undefined : deniedByPath(tool, rule, access);
  const outside = words.filter((word) => judged.leaves(word, 0) && !judged.allows({ access, word }, 0)).map((word) => word.text);
  if (outside.length === 0) return { denied, outside: undefined };
  return { denied, outside: NeedText.make(`it ${access} outside the working folder: ${listed(outside.map((path) => coded(WordText.make(path))))}`) };
};

/** The rules in `list` about tools and programs, read; path rules (`Read(...)`, `Edit(...)`) are not among them. */
const programRules = (list: ReadonlyArray<PermissionRule>): ReadonlyArray<ParsedRule> => list.filter((rule) => pathRuleOf(rule) === undefined).map(parseRule);

/** The step for a call to command tool `tool` (see the module's comment). */
const commandStep = (
  request: { readonly input: Received },
  tool: ToolName,
  kind: ToolKind,
  mode: PermissionMode,
  canAsk: boolean,
  facts: ReadonlyArray<Fact>,
  judging: CommandJudging,
): PolicyStep<PermissionQuestion> => {
  const allow = programRules(judging.settings.allow).filter((rule) => namesTool(rule, tool, true));
  const deny = programRules(judging.settings.deny).filter((rule) => namesTool(rule, tool, true));
  const toolDeny = deny.find((rule) => rule.words === undefined);
  if (toolDeny !== undefined) return veto(`${tool} is denied by the rule ${toolDeny.rule}.`);
  const session = sessionAnswersFor(facts, tool);
  const command = commandIn(request.input);
  const split = command === undefined ? undefined : unitsOf(command, judging.segmentsOf, judging.folders);
  const units = split?._tag === "Units" ? split.units : [];
  // Path rules (`Read(...)`, `Edit(...)`): a deny rule refuses a read or a change of a path it
  // matches, in every mode; an allow rule lifts a path outside the working folder that it matches.
  // Program rules say which programs run, not where they read and change files.
  const paths = pathJudging(judging, units);
  const denied = units.flatMap((unit, at) => {
    const rule = deny.find((each) => denies(each, unit));
    if (rule !== undefined) return [`${programOf(unit)} is denied by the rule ${rule.rule}`];
    const pathDenied = unit.paths.flatMap((path) => {
      const pathRule = paths.deniedBy(path, at);
      return pathRule === undefined ? [] : [deniedByPath(programOf(unit), pathRule, path.access)];
    })[0];
    if (pathDenied !== undefined) return [pathDenied];
    const grant = unit.grant;
    return grant !== undefined && session.rejected.some((rejected) => sameGrant(rejected, grant)) ? [`${shownGrant(grant)} was rejected for the rest of the session`] : [];
  });
  if (denied.length > 0) return veto(`${denied.join("; ")}.`);
  // Deny rules with words cannot see a command that does not parse, or a program whose name is not
  // written out; when there are such rules, those run only after a question, even in bypassPermissions.
  const unseen: ReadonlyArray<CommandNeed> = !deny.some((rule) => rule.words !== undefined) && paths.deny.length === 0
    ? []
    : split === undefined || split._tag === "Unparsed"
      ? [{ program: WordText.make(command ?? "the command"), kind: "unseen", why: NeedText.make("deny rules cannot see what it runs: it does not parse") }]
      : units.flatMap((unit, at): ReadonlyArray<CommandNeed> => [
          ...(deny.some((rule) => rule.words !== undefined) && unit.words.length > 0 && unit.words[0]?.literal === undefined
            ? [{ program: programOf(unit), kind: "unseen" as const, why: NeedText.make("deny rules cannot see what it runs: its program's name is not written out") }]
            : []),
          ...unit.paths.flatMap((path) => present(paths.unseen(path, at)).map((why) => ({ program: programOf(unit), kind: "unseen" as const, why }))),
        ]);
  if ((allow.some((rule) => rule.words === undefined) || mode === "bypassPermissions") && unseen.length === 0) return proceed;
  if (mode === "bypassPermissions" || allow.some((rule) => rule.words === undefined)) return asked(unseen, [], tool, kind, mode, canAsk, command);
  const allowed = (unit: Unit): boolean => {
    if (unit.words.length === 0 || allow.some((rule) => ruleNamesProgram(rule, unit, false))) return true;
    if (unit.opaque !== undefined) return false;
    const grant = unit.grant;
    return judging.settings.readOnly.some((prefix) => readOnlyNames(prefix, unit)) || (grant !== undefined && session.allowed.some((each) => sameGrant(each, grant)));
  };
  const needs: ReadonlyArray<CommandNeed> =
    split === undefined || split._tag === "Unparsed"
      ? [{ program: WordText.make(command ?? "the command"), kind: "unparsed", why: NeedText.make(split?._tag === "Unparsed" ? `it does not parse: ${split.reason}` : "the call's input has no command") }]
      : units.flatMap((unit, at) => {
          const program = programOf(unit);
          // A path that a path allow rule matches needs no permission; the others are named.
          const unallowed = unit.paths.filter((path) => !paths.allows(path, at));
          const writes = unallowed.flatMap((path) => (path.access === "writes" && path.word !== undefined && !paths.leaves(path.word, at) ? [wordText(path.word)] : []));
          const readsOutside = unallowed.flatMap((path) => (path.access === "reads" && path.word !== undefined && paths.leaves(path.word, at) ? [wordText(path.word)] : []));
          const changesOutside = unallowed.flatMap((path): ReadonlyArray<OutsideChange> => {
            if (path.access === "reads") return [];
            // Paths xargs gives may be anywhere; those find gives are under its starting points, judged as find's own.
            if (path.word === undefined) return path.givenBy === "find" ? [] : [{ verb: path.access, path: undefined }];
            return paths.leaves(path.word, at) ? [{ verb: path.access, path: wordText(path.word) }] : [];
          });
          const own: ReadonlyArray<CommandNeed> = [
            ...(allowed(unit) ? [] : [unit.opaque === undefined ? { program, kind: "notAllowed" as const, why: NeedText.make("it is not allowed yet") } : { program, kind: "opaque" as const, why: unit.opaque }]),
            ...(writes.length === 0 || mode === "acceptEdits" ? [] : [{ program, kind: "writes" as const, why: NeedText.make(`it writes ${listed(writes.map(coded))}`) }]),
            ...(readsOutside.length === 0 ? [] : [{ program, kind: "readsOutside" as const, why: NeedText.make(`it reads outside the working folder: ${listed(readsOutside.map(coded))}`) }]),
            ...changesOutsideNeeds(program, changesOutside),
          ];
          return own;
        });
  if (needs.length === 0) return proceed;
  const needing = units.filter((unit) => !allowed(unit));
  const grantable = needs.every((each) => each.kind === "notAllowed") && needing.every((unit) => unit.grant !== undefined);
  const grants = grantable ? needing.flatMap((unit) => (unit.grant === undefined ? [] : [unit.grant])).filter((grant, at, all) => all.findIndex((other) => sameGrant(other, grant)) === at) : [];
  return asked(needs, grants, tool, kind, mode, canAsk, command);
};

/** The needs of `program` for the paths outside the working folder that it changes, one for each way it changes them. */
const changesOutsideNeeds = (program: WordText, changes: ReadonlyArray<OutsideChange>): ReadonlyArray<CommandNeed> =>
  [...new Set(changes.map((change) => change.verb))].map((verb) => {
    const paths = changes.flatMap((change) => (change.verb === verb && change.path !== undefined ? [change.path] : []));
    const fed = changes.some((change) => change.verb === verb && change.path === undefined);
    const named = paths.length === 0 ? [] : [`it ${verb} outside the working folder: ${listed(paths.map(coded))}`];
    const input = fed ? [`it ${verb} the paths it reads from its input, which may be outside the working folder`] : [];
    return { program, kind: "changesOutside", why: NeedText.make([...named, ...input].join("; ")) };
  });

/** Asks about `needs`, offering `grants` for the session; or vetoes, naming them, in `dontAsk` mode or when no one can answer. */
const asked = (
  needs: ReadonlyArray<CommandNeed>,
  grants: ReadonlyArray<Grant>,
  tool: ToolName,
  kind: ToolKind,
  mode: PermissionMode,
  canAsk: boolean,
  command: ShellCommand | undefined,
): PolicyStep<PermissionQuestion> => {
  const described = listed(needs.map((each) => WordText.make(`${each.program} (${each.why})`)));
  if (mode === "dontAsk") return veto(`${tool} needs permission, and the permission mode is dontAsk: ${described}.`);
  if (!canAsk) {
    const onlyWrites = needs.every((each) => each.kind === "writes");
    const unseen = needs.some((each) => each.kind === "unseen");
    const hint = unseen ? "Write the command out, so that the deny rules can see what it runs." : `--permission-mode ${onlyWrites ? "acceptEdits or bypassPermissions" : "bypassPermissions"} lets it run.`;
    return veto(`${tool} needs permission, and no one is there to answer: ${described}. ${hint}`);
  }
  return ask({ _tag: "Command", tool, kind, options: commandOptions(grants), command: command ?? ShellCommand.make(""), needs, grants });
};

/**
 * Returns the permission policy for a session in `mode`, as `facts` stand. `kindOf` returns a tool's
 * kind; a tool that it does not know is treated as `other`. `canAsk` is whether anyone can answer a
 * question. `commands` judges the calls to command tools by their programs; without it, those calls
 * are judged by their tool's kind, as any other call. The allow and deny rules for tools other than
 * command tools come from `commands`' settings too.
 */
export function permissions(
  mode: PermissionMode,
  canAsk: boolean,
  kindOf: (tool: ToolName) => ToolKind | undefined,
  facts: ReadonlyArray<Fact>,
  commands?: CommandJudging,
): Policy<PermissionQuestion> {
  return {
    start: (request) => {
      if (request._tag !== "RunTool") return proceed;
      const kind = kindOf(request.tool) ?? "other";
      if (commands !== undefined && commands.settings.commandTools.includes(request.tool)) return commandStep(request, request.tool, kind, mode, canAsk, facts, commands);
      const rules = (list: ReadonlyArray<PermissionRule>) => programRules(list).filter((rule) => rule.words === undefined && namesTool(rule, request.tool, false));
      const denyRule = rules(commands?.settings.deny ?? [])[0];
      if (denyRule !== undefined) return veto(`${request.tool} is denied by the rule ${denyRule.rule}.`);
      // A tool's path inputs are judged as a command's paths: a deny rule refuses, and a path outside the
      // working folders is asked about, with only this call to allow, unless a path rule or a rule for the tool allows it.
      const paths = commands === undefined ? undefined : toolPaths(request.input, request.tool, kind, commands);
      if (paths?.denied !== undefined) return veto(`${paths.denied}.`);
      if (paths?.outside !== undefined && rules(commands?.settings.allow ?? []).length === 0 && mode !== "bypassPermissions") {
        if (mode === "dontAsk") return veto(`${request.tool} needs permission, and the permission mode is dontAsk: ${paths.outside}.`);
        if (!canAsk) return veto(`${request.tool} needs permission, and no one is there to answer: ${paths.outside}. --permission-mode bypassPermissions lets it run.`);
        return ask({ _tag: "Tool", tool: request.tool, kind, options: commandOptions([]), why: paths.outside });
      }
      if (onlyReads.includes(kind)) return proceed;
      const sessionAnswer = sessionAnswersFor(facts, request.tool).tool;
      // A session rejection applies in every mode, so it is checked before the mode.
      if (sessionAnswer === "rejected") return veto(`${request.tool} was rejected for the rest of the session.`);
      if (rules(commands?.settings.allow ?? []).length > 0) return proceed;
      if (mode === "bypassPermissions") return proceed;
      if (mode === "acceptEdits" && editsFiles.includes(kind)) return proceed;
      if (sessionAnswer === "allowed") return proceed;
      if (mode === "dontAsk") return veto(`${request.tool} needs permission, and the permission mode is dontAsk.`);
      if (!canAsk) {
        const allowingModes = editsFiles.includes(kind) ? "acceptEdits or bypassPermissions" : "bypassPermissions";
        return veto(`${request.tool} needs permission, and no one is there to answer. --permission-mode ${allowingModes} lets it run.`);
      }
      return ask({ _tag: "Tool", tool: request.tool, kind, options: toolOptions(request.tool) });
    },
    receive: (question, message) => {
      if (message._tag === "AskingFailed") return veto(`The question about this call to ${question.tool} could not be asked: ${message.problem}`);
      if (message._tag !== "Answered") return { _tag: "Waiting", state: question, asks: undefined };
      if (answerIn(message.answer)?.outcome === "cancelled") return veto(`The question about this call to ${question.tool} was cancelled before it was answered.`);
      const picked = optionPicked(question, message.answer);
      if (picked === undefined) return veto(`The answer named no option offered for ${question.tool}.`);
      return picked.kind === "allow_once" || picked.kind === "allow_always" ? proceed : veto(`The user rejected this call to ${question.tool}.`);
    },
  };
}
