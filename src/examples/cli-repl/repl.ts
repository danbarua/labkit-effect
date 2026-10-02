/**
 * The REPL: a prompt, the user's input to the model, its answer, and again, until `/exit`. A line
 * that starts with `/` is one of the REPL's own commands (`commands.ts`) and does not go to the model;
 * Tab completes a command, a model's name and a setting, from what the session's model takes.
 * With input that is not a terminal there is nothing to prompt: it answers the first prompt, if one
 * was given, and ends.
 *
 * Each tool call is shown as it ends: the tool and its input, then what it returned or why it
 * failed. Before a tool call that needs permission runs, the question is recorded
 * (`PermissionAsked`), and the REPL asks it: the user picks an option, which is recorded as the
 * answer (`PermissionAnswered`). Ctrl+C at the question rejects the call.
 */

import { Console, Effect, PubSub } from "effect";
import { Prompt } from "effect/cli";
import type { Fact } from "../../agent-machine/fact.ts";
import { answerPicking, OptionId, type PermissionQuestion, questionIn } from "../../agent-policy/permissions.ts";
import type { CallId } from "../../agent-machine/names.ts";
import type { ToolOutcome } from "../../agent-machine/observation.ts";
import type { Session } from "../../agent-session/loop.ts";
import { asText } from "../../agent-session/received.ts";
import { command, completions, offered } from "./commands.ts";
import { bracketedPaste, Multiline } from "./multiline.ts";
import { answerTo, ask, type Config, endingOf, lastTurn, logFileOf } from "./session.ts";

/** What is printed after a turn: the answer, or how the turn ended when it gave none. */
const replyTo = (facts: ReadonlyArray<Fact>): string => {
  const turn = lastTurn(facts);
  const ending = endingOf(facts, turn);
  const answer = answerTo(facts, turn);
  if (ending?._tag === "Failed") return `(the turn failed: ${ending.failure})`;
  return answer !== "" ? answer : `(the turn ended ${ending?._tag ?? "with nothing recorded"}, with no answer)`;
};

const turn = (session: Session, input: string) =>
  ask(session, input).pipe(
    Effect.andThen(session.facts),
    Effect.flatMap((facts) => Console.log(replyTo(facts))),
  );

/** The input `call` was given, as the facts hold it with the call. */
const inputOf = (facts: ReadonlyArray<Fact>, call: CallId): string => {
  const found = facts.flatMap((fact) => {
    if (fact._tag !== "Observed") return [];
    const observation = fact.observation;
    if (observation._tag === "ToolCallArrived" && observation.call === call) return [observation.input];
    if (observation._tag === "ModelResponded") return observation.parts.flatMap((part) => (part._tag === "ToolCall" && part.call === call ? [part.input] : []));
    return [];
  })[0];
  return found === undefined ? "" : asText(found);
};

/** The question as it is shown: the tool, its kind, and the call's input. */
const shown = (question: PermissionQuestion, input: string): string => `Run ${question.tool} (${question.kind})? ${input}`;

/** Text in one line of at most `width` characters, with how many more lines it has. */
const oneLine = (text: string, width = 200): string => {
  const [first = "", ...rest] = text.split("\n");
  const cut = first.length > width ? `${first.slice(0, width)}…` : first;
  return rest.length === 0 ? cut : `${cut} (+${rest.length} more line${rest.length === 1 ? "" : "s"})`;
};

/** How a tool call ended, in one line: what it returned, or why it failed. */
const endedAs = (outcome: ToolOutcome): string => {
  if (outcome._tag === "Succeeded") return oneLine(asText(outcome.output));
  const reason = outcome.reason;
  switch (reason._tag) {
    case "Reported":
      return `failed: ${oneLine(asText(reason.error))}`;
    case "InputRejected":
      return `input rejected: ${oneLine(reason.problem)}`;
    case "Vetoed":
      return `not run: ${oneLine(asText(reason.reason))}`;
    case "NotFound":
      return "no such tool";
    case "NotRun":
      return "not run";
    case "Indeterminate":
      return "how it ended was not observed";
    default:
      return reason satisfies never;
  }
};

/** A tool call that ended, as it is shown: the tool and its input, then how it ended. */
const shownEnded = (tool: string, input: string, outcome: ToolOutcome): string => `● ${tool} ${oneLine(input)}\n  \x1b[2m⎿ ${endedAs(outcome)}\x1b[0m`;

/** The tool a call asked for, as the facts hold it with the call. */
const toolOf = (facts: ReadonlyArray<Fact>, call: CallId): string =>
  facts.flatMap((fact) => {
    if (fact._tag !== "Observed") return [];
    const observation = fact.observation;
    if (observation._tag === "ToolCallArrived" && observation.call === call) return [observation.tool];
    if (observation._tag === "ModelResponded") return observation.parts.flatMap((part) => (part._tag === "ToolCall" && part.call === call ? [part.tool] : []));
    return [];
  })[0] ?? "(a tool)";

/**
 * Follows the session's facts as they are recorded, for as long as the scope lasts: asks each
 * question recorded before a call runs, and shows each tool call as it ends.
 */
const following = (session: Session) =>
  Effect.gen(function* () {
    const recorded = yield* session.subscribe;
    const answer = (fact: Fact) =>
      Effect.gen(function* () {
        if (fact._tag === "Observed" && fact.observation._tag === "ToolEnded") {
          const facts = yield* session.facts;
          return yield* Console.log(shownEnded(toolOf(facts, fact.observation.call), inputOf(facts, fact.observation.call), fact.observation.outcome));
        }
        if (fact._tag !== "Observed" || fact.observation._tag !== "PermissionAsked") return;
        const { call, asks } = fact.observation;
        const question = questionIn(asks);
        if (question === undefined) return;
        const rejecting = question.options.find((option) => option.kind === "reject_once")?.optionId ?? OptionId.make("reject-once");
        const picked = yield* Prompt.Select({
          message: shown(question, inputOf(yield* session.facts, call)),
          choices: question.options.map((option) => ({ title: option.name, value: option.optionId })),
        }).pipe(Effect.catchTag("QuitError", () => Effect.succeed(rejecting)));
        yield* session.observe({ _tag: "PermissionAnswered", call, answer: answerPicking(picked) });
      });
    yield* Effect.forkScoped(Effect.forever(PubSub.take(recorded).pipe(Effect.flatMap(answer))));
  });

export const repl = (session: Session, config: Config, first: string | undefined, interactive: boolean) =>
  Effect.scoped(Effect.gen(function* () {
    yield* Console.log(`${config.target.provider}/${config.target.model} · /help for commands, /exit to quit. Log: ${logFileOf(config.sessionId)}`);
    if (interactive) yield* following(session);
    if (first !== undefined) yield* turn(session, first);
    if (!interactive) return;
    yield* bracketedPaste;
    while (true) {
      const input = yield* Multiline(completions(yield* offered(session)));
      if (input === "/exit" || input === "/quit") break;
      if (input.trim() === "") continue;
      if (input.startsWith("/")) {
        // A mistake in a command is said, and the REPL goes on.
        const said = yield* command(session, input).pipe(Effect.catchTag("UserError", (error) => Effect.succeed(String(error.userMessage))));
        yield* Console.log(said ?? `No command ${input.split(/\s+/)[0] ?? input}. /help lists them.`);
        continue;
      }
      yield* turn(session, input);
    }
  }));
