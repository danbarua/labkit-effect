/**
 * The REPL: a prompt, the user's input to the model, its answer, and again, until `/exit`. A line
 * that starts with `/` is one of the REPL's own commands (`commands.ts`) and does not go to the model;
 * Tab completes a command, a model's name and a setting, from what the session's model takes.
 * With input that is not a terminal there is nothing to prompt: it answers the first prompt, if one
 * was given, and ends.
 *
 * A response's text is printed as it arrives (`streamed`), its thinking dimmed; when a turn ends,
 * what is printed is what the stream did not say: that the answer was cut short, that the turn
 * failed or gave no answer, or the answer itself when the last response did not stream it. Each tool
 * call is shown as it ends: the tool and its input, then what it returned or why it failed. Before a tool call that needs permission runs, the question is recorded
 * (`PermissionAsked`), and the REPL asks it: the user picks an option, which is recorded as the
 * answer (`PermissionAnswered`). Ctrl+C at the question rejects the call.
 */

import { Console, Effect, PubSub } from "effect";
import { Prompt } from "effect/cli";
import type { Fact } from "../../agent-machine/fact.ts";
import { answerPicking, OptionId, type PermissionQuestion, questionIn } from "../../agent-policy/permissions.ts";
import type { CallId, TurnId } from "../../agent-machine/names.ts";
import type { CapturedObservation, ToolOutcome } from "../../agent-machine/observation.ts";
import type { Services, Session } from "../../agent-session/loop.ts";
import { asText } from "../../agent-session/received.ts";
import { command, completions, offered } from "./commands.ts";
import { bracketedPaste, Multiline } from "./multiline.ts";
import { answerTo, ask, type Config, endingOf, type Host, lastTurn, logFileOf } from "./session.ts";
import type { LeftRunning } from "../../agent-machine/left-running.ts";

/** Of each session the REPL follows: the turns whose last response printed its text as it arrived. */
const streamedLast = new WeakMap<Session, Map<TurnId, boolean>>();

/**
 * What is printed after a turn: the answer, unless it was printed as it arrived; saying so when it
 * was cut short; or how the turn ended when it gave none. Nothing, when the stream said it all.
 */
const replyTo = (session: Session, facts: ReadonlyArray<Fact>): string | undefined => {
  const turn = lastTurn(facts);
  const ending = endingOf(facts, turn);
  const answer = answerTo(facts, turn);
  if (ending?._tag === "Failed") return `(the turn failed: ${ending.failure})`;
  if (answer === "") return `(the turn ended ${ending?._tag ?? "with nothing recorded"}, with no answer)`;
  // An answer cut short by a length limit (the output limit, or the context window) says so.
  const cut = ending?._tag === "CutShort" ? "(cut short: the response reached its length limit)" : undefined;
  if (turn !== undefined && streamedLast.get(session)?.get(turn) === true) return cut;
  return cut === undefined ? answer : `${answer}\n${cut}`;
};

const printReply = (session: Session) =>
  Effect.flatMap(session.facts, (facts) => {
    const reply = replyTo(session, facts);
    return reply === undefined ? Effect.void : Console.log(reply);
  });

const turn = (session: Session, input: string) => ask(session, input).pipe(Effect.andThen(printReply(session)));

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
 * question recorded before a call runs, and shows each tool call as it ends. Prints each response's
 * text as it arrives, its thinking dimmed, and notes whether a turn's last response printed its
 * answer so (`streamedLast`).
 */
const following = (session: Session) =>
  Effect.gen(function* () {
    const recorded = yield* session.subscribe;
    const streamed = yield* session.streamed;
    const last = new Map<TurnId, boolean>();
    streamedLast.set(session, last);
    // The kind of text the line printed last holds, while it is not ended; whether this response printed any answer.
    let open: "answer" | "thinking" | undefined;
    let answered = false;
    const write = (text: string) => Effect.sync(() => void process.stdout.write(text));
    const endLine = Effect.suspend(() => {
      if (open === undefined) return Effect.void;
      open = undefined;
      return write("\n");
    });
    const print = (item: CapturedObservation) =>
      Effect.gen(function* () {
        if (item._tag === "ModelResponseEnded") {
          last.set(item.turn, answered);
          answered = false;
          return yield* endLine;
        }
        if (item._tag !== "ModelDelta" || item.text === "") return;
        const kind = item.kind === "Thinking" ? "thinking" : "answer";
        if (open !== kind) yield* endLine;
        open = kind;
        if (kind === "answer") answered = true;
        yield* write(kind === "thinking" ? `\x1b[2m${item.text}\x1b[0m` : item.text);
      });
    yield* Effect.forkScoped(Effect.forever(PubSub.take(streamed).pipe(Effect.flatMap(print))));
    const answer = (fact: Fact) =>
      Effect.gen(function* () {
        if (fact._tag === "Observed" && fact.observation._tag === "ToolEnded") {
          const facts = yield* session.facts;
          yield* endLine;
          return yield* Console.log(shownEnded(toolOf(facts, fact.observation.call), inputOf(facts, fact.observation.call), fact.observation.outcome));
        }
        if (fact._tag !== "Observed" || fact.observation._tag !== "PermissionAsked") return;
        const { call, asks } = fact.observation;
        const question = questionIn(asks);
        if (question === undefined) return;
        const rejecting = question.options.find((option) => option.kind === "reject_once")?.optionId ?? OptionId.make("reject-once");
        yield* endLine;
        const picked = yield* Prompt.Select({
          message: shown(question, inputOf(yield* session.facts, call)),
          choices: question.options.map((option) => ({ title: option.name, value: option.optionId })),
        }).pipe(Effect.catchTag("QuitError", () => Effect.succeed(rejecting)));
        yield* session.observe({ _tag: "PermissionAnswered", call, answer: answerPicking(picked) });
      });
    yield* Effect.forkScoped(Effect.forever(PubSub.take(recorded).pipe(Effect.flatMap(answer))));
  });

/** A request a turn left running, in words: a model request, or a tool call, and whether it began. */
const shownLeft = (request: LeftRunning["requests"][number], began: ReadonlySet<CallId>): string => {
  switch (request._tag) {
    case "RequestModelResponse":
      return "a model request";
    case "RunTool":
      return `${request.tool} ${oneLine(asText(request.input), 80)} (${began.has(request.call) ? "began" : "not begun"}; it runs only if it changes nothing)`;
    case "BeforeTurnEnded":
      return "the review before the turn ends";
    default:
      return request satisfies never;
  }
};

/**
 * The REPL at a terminal: it follows the session from when it opens (`following`), and asks the
 * user whether to go on with a turn the session's facts left running, or end it.
 */
export const Terminal: Host<Prompt.Environment | Services> = {
  follow: following,
  choose: (left) =>
    Prompt.Select({
      message: `The last session stopped while ${left.turn} ran${left.stopping ? ", being interrupted" : ""}, with ${left.requests.map((request) => shownLeft(request, left.began)).join("; ") || "nothing under way"}. Go on with it?`,
      choices: [
        { title: "Go on with it", value: "go on" as const },
        { title: "End it, as interrupted", value: "end" as const },
      ],
    }).pipe(Effect.orElseSucceed(() => "end" as const)),
  wentOn: printReply,
};

export const repl = (session: Session, config: Config, first: string | undefined, interactive: boolean) =>
  Effect.scoped(Effect.gen(function* () {
    yield* Console.log(`${config.target.provider}/${config.target.model} · /help for commands, /exit to quit. Log: ${logFileOf(config.sessionId)}`);
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
