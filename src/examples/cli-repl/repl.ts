/**
 * The REPL: a prompt, the user's input to the model, its answer, and again, until `/exit`. A line
 * that starts with `/` is one of the REPL's own commands (`commands.ts`) and does not go to the model;
 * Tab completes a command, a model's name and a setting, from what the session's model takes.
 * With input that is not a terminal there is nothing to prompt: it answers the first prompt, if one
 * was given, and ends. At a terminal, a new session whose model cannot be asked starts in the REPL
 * without a model (`withoutModel`), and the session opens once `/model` names one that can be asked.
 *
 * The REPL follows the session (`following`) as ACP's host does (`agent-acp/feed.ts`): the
 * session's facts and what its model requests pass on are merged as they come, and each goes
 * through ACP's projection (`agent-acp/projection.ts`, mode `live`). The projection gives each part
 * of a response's text once, whether its deltas or its `ModelResponded` arrive first; the REPL
 * prints the answer's text as it comes, and the thinking's dimmed. When a turn ends, the REPL waits
 * until the follower has taken the turn's end, and then prints what the text did not say: that the
 * answer was cut short or interrupted, or that the turn failed or gave no answer.
 *
 * Each tool call is shown as it ends: the tool and its input, then what it returned or why it
 * failed. Before a tool call that needs permission runs, the question is recorded
 * (`PermissionAsked`), and the REPL asks it: the user picks an option, which is recorded as the
 * answer (`PermissionAnswered`). Ctrl+C at the question rejects the call. While a turn runs, Ctrl+C
 * interrupts it, and other keys are dropped (`turn-keys.ts`).
 */

import type { McpServers } from "../../agent-mcp/servers.ts";
import { Console, Deferred, Effect, HashMap, Option, PubSub, Queue, Ref } from "effect";
import type { SessionUpdate } from "effective-acp/schema/v1";
import { next, presentFrom, type ProjectionInput, project } from "../../agent-acp/projection.ts";
import { immutableToolCatalogOf } from "../../agent-session/configuration/session-setup.ts";
import { Prompt } from "effect/cli";
import type { Fact } from "../../agent-machine/fact.ts";
import { answerPicking, OptionId, type PermissionQuestion, questionIn } from "../../agent-policy/permissions.ts";
import type { CallId, TurnId } from "../../agent-machine/names.ts";
import type { ToolOutcome } from "../../agent-machine/observation.ts";
import type { Services, Session } from "../../agent-session/loop.ts";
import { asText } from "../../agent-session/received.ts";
import { command, commands, completions, help, modelNamed, noCommand, offered, offeredWithoutModel } from "./commands.ts";
import { invalid } from "./invalid.ts";
import { type CannotAsk, saidOf, targetOf } from "./models.ts";
import { bracketedPaste, Multiline } from "./multiline.ts";
import { answerTo, ask, type Config, endingOf, type Host, lastTurn, logFileOf } from "./session.ts";
import type { LeftRunning } from "../../agent-machine/left-running.ts";
import { type TurnKeys, turnKeys } from "./turn-keys.ts";
import { logKeys } from "./log-keys.ts";

/** What the REPL keeps of a session it follows at a terminal. */
interface Following {
  /** Who holds the terminal's keys while a turn runs. */
  readonly keys: TurnKeys;
  /** Completes once the follower has taken `turn`'s end: every update of the turn has been printed. */
  readonly turnEnded: (turn: TurnId) => Effect.Effect<void>;
}

/** Of each session the REPL follows at a terminal: what it keeps of it. */
const followers = Ref.makeUnsafe(HashMap.empty<Session, Following>());

/** What a turn's ending adds to an answer: that it was cut short by a length limit, or interrupted. */
const cutNote = (ending: ReturnType<typeof endingOf>): string | undefined => {
  if (ending?._tag === "CutShort") return "(cut short: the response reached its length limit)";
  return ending?._tag === "Interrupted" ? "(interrupted)" : undefined;
};

/**
 * What is printed after a turn: the answer, unless it was printed as it arrived (`printed`); saying
 * so when it was cut short; or how the turn ended when it gave none. Nothing, when the stream said it all.
 */
export const replyOf = (facts: ReadonlyArray<Fact>, printed: (turn: TurnId) => boolean): string | undefined => {
  const turn = lastTurn(facts);
  const ending = endingOf(facts, turn);
  const answer = answerTo(facts, turn);
  if (ending?._tag === "Failed") return `(the turn failed: ${ending.failure})`;
  if (answer === "") return ending?._tag === "Interrupted" ? "(interrupted)" : `(the turn ended ${ending?._tag ?? "with nothing recorded"}, with no answer)`;
  // An answer cut short by a length limit (the output limit, or the context window), or by Ctrl+C, says so.
  const cut = cutNote(ending);
  if (turn !== undefined && printed(turn)) return cut;
  return cut === undefined ? answer : `${answer}\n${cut}`;
};

/**
 * Prints what follows the session's last turn. A session the REPL follows has printed the turn's
 * text: once the follower has taken the turn's end, only what the text did not say is printed. A
 * session it does not follow is printed the whole reply.
 */
const printReply = (session: Session) =>
  Effect.gen(function* () {
    const follower = Option.getOrUndefined(HashMap.get(yield* Ref.get(followers), session));
    const ended = yield* session.facts;
    const turn = lastTurn(ended);
    if (follower !== undefined && turn !== undefined && endingOf(ended, turn) !== undefined) yield* follower.turnEnded(turn);
    const reply = replyOf(yield* session.facts, () => follower !== undefined);
    if (reply !== undefined) yield* Console.log(reply);
  });

/**
 * A turn: the input to the model, and what is printed once it ends. While it runs the REPL holds
 * the terminal's keys (`turn-keys.ts`): Ctrl+C interrupts the turn, which ends `Interrupted`.
 */
const turn = (session: Session, input: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const keys = Option.getOrUndefined(HashMap.get(yield* Ref.get(followers), session))?.keys;
      if (keys !== undefined) {
        const interrupted = yield* Deferred.make<void>();
        yield* Effect.acquireRelease(
          Effect.sync(() => keys.hold(() => Deferred.doneUnsafe(interrupted, Effect.void))),
          () => Effect.sync(keys.release),
        );
        yield* Effect.forkScoped(Deferred.await(interrupted).pipe(Effect.andThen(session.cancel), Effect.ignore));
      }
      yield* ask(session, input);
    }),
  ).pipe(Effect.andThen(printReply(session)));

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

/** The text of a chunk the projection gives, and whether it is thinking; nothing for any other update. */
const chunkOf = (update: SessionUpdate): { readonly kind: "answer" | "thinking"; readonly text: string } | undefined => {
  if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") return undefined;
  if (update.content.type !== "text") return undefined;
  return { kind: update.sessionUpdate === "agent_thought_chunk" ? "thinking" : "answer", text: update.content.text };
};

/**
 * Follows the session, for as long as the scope lasts: its facts and what its model requests pass
 * on, merged into one inbox, each taken in turn through ACP's projection (`next`, mode `live`) from
 * the state of the facts before (`project`, mode `replay`), so nothing they showed is shown again.
 * Prints the text the projection gives, its thinking dimmed; shows each tool call as it ends; asks
 * each question recorded before a call runs; and marks each turn's end once it is taken.
 */
const following = (session: Session) =>
  Effect.gen(function* () {
    const recorded = yield* session.subscribe;
    const streamed = yield* session.streamed;
    const inbox = yield* Queue.unbounded<ProjectionInput>();
    const before = yield* session.facts;
    const present = presentFrom(yield* immutableToolCatalogOf(before));
    const replayed = (yield* project(before, { mode: "replay", present })).state;
    const state = yield* Ref.make(replayed);
    // The turns whose end the follower has taken, every update printed: those that ended before it followed, then each it takes.
    const taken = yield* Ref.make<ReadonlySet<TurnId>>(replayed.ended);
    // What completes when each turn's end is taken, by the turn: made when first asked for.
    const ends = yield* Ref.make(HashMap.empty<TurnId, Deferred.Deferred<void>>());
    const endOf = (turn: TurnId): Effect.Effect<Deferred.Deferred<void>> =>
      Ref.modify(ends, (all) =>
        Option.match(HashMap.get(all, turn), {
          onSome: (found) => [found, all] as const,
          onNone: () => {
            const made = Deferred.makeUnsafe<void>();
            return [made, HashMap.set(all, turn, made)] as const;
          },
        }),
      );
    const keys = turnKeys();
    const turnEnded = (turn: TurnId) => Effect.flatMap(Ref.get(taken), (ended) => (ended.has(turn) ? Effect.void : Effect.flatMap(endOf(turn), Deferred.await)));
    yield* Ref.update(followers, HashMap.set(session, { keys, turnEnded }));
    // The kind of text the line printed last holds, while it is not ended.
    const open = yield* Ref.make<"answer" | "thinking" | undefined>(undefined);
    const write = (text: string) => Effect.sync(() => void process.stdout.write(text));
    const endLine = Effect.flatMap(Ref.getAndSet(open, undefined), (was) => (was === undefined ? Effect.void : write("\n")));
    const printed = (update: SessionUpdate) =>
      Effect.gen(function* () {
        const chunk = chunkOf(update);
        if (chunk === undefined || chunk.text === "") return;
        if ((yield* Ref.get(open)) !== chunk.kind) yield* endLine;
        yield* Ref.set(open, chunk.kind);
        yield* write(chunk.kind === "thinking" ? `\x1b[2m${chunk.text}\x1b[0m` : chunk.text);
      });
    /** What the REPL does on a fact besides printing its text: shows a call that ended, or asks a question. */
    const acted = (fact: Fact) =>
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
        const message = shown(question, inputOf(yield* session.facts, call));
        const picked = yield* keys
          .lend(Prompt.Select({ message, choices: question.options.map((option) => ({ title: option.name, value: option.optionId })) }))
          .pipe(Effect.catchTag("QuitError", () => Effect.succeed(rejecting)));
        yield* session.observe({ _tag: "PermissionAnswered", call, answer: answerPicking(picked) });
      });
    const take = (input: ProjectionInput) =>
      Effect.gen(function* () {
        const step = yield* next(yield* Ref.get(state), input, { mode: "live", present });
        yield* Ref.set(state, step.state);
        yield* Effect.forEach(step.updates, printed, { discard: true });
        if (input._tag === "ModelResponseEnded") yield* endLine;
        if (input._tag === "Observed") yield* acted(input);
        if (input._tag === "Decided" && input.decision._tag === "TurnEnded") {
          const turn = input.decision.turn;
          yield* endLine;
          yield* Ref.update(taken, (ended) => new Set([...ended, turn]));
          yield* Deferred.succeed(yield* endOf(turn), undefined);
        }
      }).pipe(
        // A defect in one input (a presentation or a write that throws) is logged; the follower goes on with the next.
        Effect.catchDefect((defect) => Effect.logError(logKeys.follow.inputFailed, { input: input._tag, cause: String(defect) })),
      );
    const forward = <A extends ProjectionInput>(subscription: PubSub.Subscription<A>) =>
      Effect.forever(PubSub.take(subscription).pipe(Effect.flatMap((item) => Queue.offer(inbox, item))));
    yield* Effect.forkScoped(forward(recorded));
    yield* Effect.forkScoped(forward(streamed));
    yield* Effect.forkScoped(Effect.forever(Queue.take(inbox).pipe(Effect.flatMap(take))));
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

export const repl = (session: Session, config: Config, first: string | undefined, interactive: boolean, mcp?: McpServers) =>
  Effect.scoped(Effect.gen(function* () {
    yield* Console.log(`${config.target.provider}/${config.target.model} · /help for commands, /exit to quit. Log: ${logFileOf(config.sessionId)}`);
    if (first !== undefined) yield* turn(session, first);
    if (!interactive) return;
    yield* bracketedPaste;
    /** Reads a line and does what it says; whether to read another. */
    const step = Effect.gen(function* () {
      const input = yield* Multiline(completions(yield* offered(session, mcp)));
      if (input === "/exit" || input === "/quit") return false;
      if (input.trim() === "") return true;
      if (input.startsWith("/")) {
        // A mistake in a command is said, and the REPL goes on.
        const said = yield* command(session, input, process.cwd(), mcp).pipe(Effect.catchTag("UserError", (error) => Effect.succeed(String(error.userMessage))));
        yield* Console.log(said ?? String(noCommand(input).userMessage));
        return true;
      }
      yield* turn(session, input);
      return true;
    });
    yield* step.pipe(Effect.repeat({ while: (again) => again }));
  }));

/** The REPL's commands by name, as the first word of a line names them. */
const commandNames = new Set([...commands.map(([usage]) => usage.split(" ")[0] ?? usage), "/quit"]);

/**
 * The REPL at a terminal before a model is picked, for a new session whose model cannot be asked
 * (`problem`): no model is set, the model's provider has no key set, or its server does not answer.
 * No session is open, so nothing is recorded. The REPL says the problem, then reads lines:
 *
 * - `/model <name>`, or `/model` and a pick, names a model. A model that can be asked is returned,
 *   and the session opens with it; one that cannot be asked is refused, saying why.
 * - `/help` lists the commands; `/exit` (or `/quit`) returns undefined.
 * - The other commands are refused: they work once a model is picked.
 * - Input for the model is refused, saying that it was not sent and why. `first`, the prompt the
 *   command line gave, is refused in the same words.
 */
export const withoutModel = (problem: CannotAsk, first: string | undefined) =>
  Effect.scoped(
    Effect.gen(function* () {
      const notSent = String(invalid(`Not sent. ${problem.message}`, problem.hint).userMessage);
      yield* Console.log("No model to ask · /model to pick one, /help for commands, /exit to quit.");
      yield* Console.log(first === undefined ? String(saidOf(problem).userMessage) : notSent);
      yield* bracketedPaste;
      const picked = (words: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const chosen = yield* modelNamed(words, "Ask which model?");
          return chosen === undefined ? "again" : yield* targetOf(chosen, "/model");
        }).pipe(Effect.catchTag("UserError", (error) => Effect.as(Console.log(String(error.userMessage)), "again" as const)));
      /** Reads a line and does what it says: the model picked, `exit`, or `again` to read another line. */
      const step = Effect.gen(function* () {
        const input = yield* Multiline(completions(yield* offeredWithoutModel));
        if (input === "/exit" || input === "/quit") return "exit" as const;
        if (input.trim() === "") return "again" as const;
        const [name = "", ...words] = input.trim().split(/\s+/);
        if (name === "/model") return yield* picked(words);
        if (name === "/help") yield* Console.log(help());
        else if (commandNames.has(name)) yield* Console.log(String(invalid(`${name} works once a model is picked.`, "Pick one with /model.").userMessage));
        else if (input.startsWith("/")) yield* Console.log(String(noCommand(input).userMessage));
        else yield* Console.log(notSent);
        return "again" as const;
      });
      const ended = yield* step.pipe(Effect.repeat({ until: (outcome) => outcome !== "again" }));
      return ended === "exit" ? undefined : ended;
    }),
  );
