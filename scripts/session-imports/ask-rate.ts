/**
 * Measures how often the permission policy asks, over the corpus of agents' shell commands
 * (`commands.ts`), with the default settings in `default` mode:
 *
 *   bun run commands:ask-rate [--source claude-code|codex|omp]
 *
 * Each command is judged twice:
 * - **cold**: with no session answers. It runs, asks with a grant to offer for the session, asks about
 *   the call only, or does not parse;
 * - **in its session**: the session's earlier commands judged first, in timestamp order, as though
 *   the user had allowed every grant offered for the rest of the session.
 *
 * A command's paths are judged against its session's working folder and this process's home folder.
 *
 * It prints the shares overall, by source, by model (when a transcript records none, the vendor its source
 * runs: Claude for Claude Code, OpenAI for Codex), and by project (the last part of the session's
 * working folder, for the projects with the most commands), the needs that the questions name, and the grants
 * offered most. It writes each command's judgement to `judgements.jsonl` beside the corpus
 * (`{ key, cold, session, needs, grants }`), replacing the file, for later study.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { segmentsOf } from "../../src/agent-host/command-parser.ts";
import type { Fact } from "../../src/agent-machine/fact.ts";
import { CallId, ToolName } from "../../src/agent-machine/names.ts";
import { openingFolders } from "../../src/agent-host/session-context.ts";
import { answerPicking, defaultPermissionSettings, OptionId, permissions, type PermissionQuestion, questionIn } from "../../src/agent-policy/permissions.ts";
import { receivedJson } from "../../src/agent-session/received.ts";
import { type CorpusCommand, corpusFile, corpusFolder } from "./commands.ts";

type Outcome = "runs" | "asks with a grant" | "asks about the call only" | "does not parse" | "vetoed";
const outcomes: ReadonlyArray<Outcome> = ["runs", "asks with a grant", "asks about the call only", "does not parse", "vetoed"];

const sourceAt = process.argv.indexOf("--source");
const only = sourceAt === -1 ? undefined : process.argv[sourceAt + 1];
const corpus = readFileSync(corpusFile, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as CorpusCommand)
  .filter((command) => only === undefined || command.source === only)
  .sort((one, other) => one.timestamp.localeCompare(other.timestamp));

const tool = ToolName.make("run_command");

/** The policy's step for `command`, given a session's `facts`. */
const judge = (command: string, id: number, facts: ReadonlyArray<Fact>, cwd: string) =>
  permissions("default", true, () => "execute", facts, {
    settings: defaultPermissionSettings,
    segmentsOf,
    ...(cwd === "" ? {} : { folders: openingFolders({ working: cwd, additional: [] }) }),
  }).start({
    _tag: "RunTool",
    call: CallId.make(`c${id}`),
    tool,
    input: receivedJson({ command }),
  });

const outcomeOf = (step: ReturnType<typeof judge>): { readonly outcome: Outcome; readonly question: PermissionQuestion | undefined } => {
  if (step._tag === "Decided") return { outcome: step.verdict._tag === "Continue" ? "runs" : "vetoed", question: undefined };
  const question = step.asks === undefined ? undefined : questionIn(step.asks);
  if (question?._tag !== "Command") return { outcome: "asks about the call only", question };
  if (question.needs.some((need) => need.why.startsWith("it does not parse"))) return { outcome: "does not parse", question };
  return { outcome: question.grants.length > 0 ? "asks with a grant" : "asks about the call only", question };
};

/** A need's reason, with the file or path it names left out, so that reasons can be counted. */
const reasonOf = (why: string): string => why.replace(/^(it writes|it reads outside the working folder:|it does not parse:|it sets) .*/, "$1 …");

const sessions = new Map<string, Array<Fact>>();
const cold = new Map<string, Map<Outcome, number>>();
const warm = new Map<string, Map<Outcome, number>>();
const needs = new Map<string, number>();
const grants = new Map<string, number>();
const judgements: Array<string> = [];
const count = (table: Map<string, Map<Outcome, number>>, group: string, outcome: Outcome) => {
  const row = table.get(group) ?? new Map<Outcome, number>();
  row.set(outcome, (row.get(outcome) ?? 0) + 1);
  table.set(group, row);
};
const projectOf = (command: CorpusCommand) => (command.cwd === "" ? "(none)" : basename(command.cwd));

/** The vendor whose model a source's command came from when its transcript records no model: Claude Code runs Claude models, and Codex runs OpenAI's. */
const unrecorded: ReadonlyMap<CorpusCommand["source"], string> = new Map([
  ["claude-code", "Claude (model not recorded)"],
  ["codex", "OpenAI (model not recorded)"],
]);
const modelOf = (command: CorpusCommand) => command.model ?? unrecorded.get(command.source) ?? "(model not recorded)";

corpus.forEach((command, id) => {
  const first = outcomeOf(judge(command.command, id, [], command.cwd));
  const facts = sessions.get(`${command.source}:${command.session}`) ?? [];
  sessions.set(`${command.source}:${command.session}`, facts);
  const step = judge(command.command, id, facts, command.cwd);
  const inSession = outcomeOf(step);
  if (step._tag === "Waiting" && step.asks !== undefined && inSession.question?.options.some((option) => option.optionId === "allow-session") === true) {
    facts.push({ _tag: "Observed", observation: { _tag: "PermissionAsked", call: CallId.make(`c${id}`), asks: step.asks } } as unknown as Fact);
    facts.push({ _tag: "Observed", observation: { _tag: "PermissionAnswered", call: CallId.make(`c${id}`), answer: answerPicking(OptionId.make("allow-session")) } } as unknown as Fact);
  }
  for (const group of ["all", `source: ${command.source}`, `model: ${modelOf(command)}`, `project: ${projectOf(command)}`]) {
    count(cold, group, first.outcome);
    count(warm, group, inSession.outcome === "asks with a grant" || inSession.outcome === "asks about the call only" || inSession.outcome === "does not parse" ? "asks about the call only" : inSession.outcome);
  }
  const question = first.question?._tag === "Command" ? first.question : undefined;
  for (const need of question?.needs ?? []) needs.set(reasonOf(need.why), (needs.get(reasonOf(need.why)) ?? 0) + 1);
  for (const grant of question?.grants ?? []) grants.set(grant.join(" "), (grants.get(grant.join(" ")) ?? 0) + 1);
  judgements.push(JSON.stringify({ key: command.key, cold: first.outcome, session: inSession.outcome, needs: question?.needs ?? [], grants: question?.grants ?? [] }));
});

writeFileSync(join(corpusFolder, "judgements.jsonl"), `${judgements.join("\n")}\n`);

const total = (row: Map<Outcome, number> | undefined) => [...(row?.values() ?? [])].reduce((sum, each) => sum + each, 0);
const percent = (row: Map<Outcome, number> | undefined, outcome: Outcome) => `${((100 * (row?.get(outcome) ?? 0)) / Math.max(1, total(row))).toFixed(1)}%`;
const line = (group: string) => {
  const row = cold.get(group);
  const session = warm.get(group);
  return `| ${group.replace(/^(source|model|project): /, "")} | ${total(row)} | ${outcomes.slice(0, 4).map((outcome) => percent(row, outcome)).join(" | ")} | ${percent(session, "runs")} |`;
};
const header = "| | Commands | Runs | Asks, with a grant | Asks, the call only | Does not parse | Runs, in its session |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |";
const groups = (prefix: string, limit: number) =>
  [...cold.keys()]
    .filter((group) => group.startsWith(prefix))
    .sort((one, other) => total(cold.get(other)) - total(cold.get(one)))
    .slice(0, limit);

console.log(`${corpus.length} commands from ${sessions.size} sessions${only === undefined ? "" : ` (${only})`}; default settings, default mode.\n`);
console.log(header);
console.log(line("all"));
for (const group of groups("source: ", 10)) console.log(line(group));
console.log(`\nBy model (the 15 with the most commands):\n\n${header}`);
for (const group of groups("model: ", 15)) console.log(line(group));
console.log(`\nThe projects with the most commands:\n\n${header}`);
for (const group of groups("project: ", 15)) console.log(line(group));
console.log(`\nWhat the questions name (cold):\n`);
for (const [why, times] of [...needs].sort((one, other) => other[1] - one[1]).slice(0, 15)) console.log(`- ${why}: ${times}`);
console.log(`\nThe grants offered most: ${[...grants].sort((one, other) => other[1] - one[1]).slice(0, 20).map(([grant, times]) => `${grant} (${times})`).join(", ")}`);
console.log(`\nEach command's judgement: ${join(corpusFolder, "judgements.jsonl")}`);
