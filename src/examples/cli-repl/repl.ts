/**
 * The REPL: it reads a line, sends it to the model, prints the answer, and repeats until `/exit`. A
 * line that starts with `/` runs one of the REPL's commands (`commands.ts`) instead. Tab completes a
 * command name, a model name, a setting, or a value the current model supports. When input is not a
 * terminal, the REPL answers the prompt given on the command line, if any, and exits. At a terminal,
 * a new session whose model cannot be used starts without a model (`withoutModel`); the session
 * opens once `/model` or `/switch` picks a usable model.
 *
 * The REPL follows the session as the ACP host does (`agent-acp/feed.ts`): it merges the session's
 * recorded facts with the model's streamed deltas, and passes each through ACP's projection
 * (`agent-acp/projection.ts`, live mode), which emits each piece of response text once, whichever
 * arrives first. Answer text is printed as it streams, and thinking is printed dimmed. When a turn
 * ends, the REPL waits until every update of the turn has been printed, then prints a note if the
 * answer was cut short or interrupted, or if the turn failed or gave no answer.
 *
 * Each tool call is printed when it ends: the tool and its input, then its result or why it failed.
 * Before a tool call that needs permission, the REPL asks the user and records the answer
 * (`PermissionAsked`, `PermissionAnswered`); Ctrl+C at the question rejects the call. During a turn,
 * Ctrl+C interrupts it and other keys are ignored (`turn-keys.ts`), except Option+T, which shows or
 * hides thinking (`view.ts`).
 */

import type { McpServers } from "../../agent-mcp/servers.ts";
import { Console, Deferred, Effect, HashMap, Option, PubSub, Queue, Ref } from "effect";
import { Brand } from "../../agent-host/brand.ts";
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
import type { SettingsChange } from "../../agent-machine/settings.ts";
import { type CommandContext, said } from "./command.ts";
import { completions, offered, offeredWithoutModel, runInSession, runWithoutModel } from "./commands.ts";
import { invalid } from "./invalid.ts";
import { type CannotAsk, saidOf } from "./models.ts";
import { bracketedPaste, type KeyBinding, Multiline } from "./multiline.ts";
import type { Host } from "../../agent-host/with-session.ts";
import { errorLines, failureOf } from "./failure.ts";
import { answerTo, ask, type Config, endingOf, lastTurn, logFileOf } from "./session.ts";
import type { LeftRunning } from "../../agent-machine/left-running.ts";
import { type TurnKeys, turnKeys } from "./turn-keys.ts";
import { logKeys } from "./log-keys.ts";
import { isOptionT, optionT, toggleThinking, type View } from "./view.ts";

/** The REPL's state for a session it follows at a terminal. */
interface Following {
  /** The terminal's keys during a turn. */
  readonly keys: TurnKeys;
  /** Completes when every update of `turn` has been printed. */
  readonly turnEnded: (turn: TurnId) => Effect.Effect<void>;
  /** Prints `note` dimmed, on its own line. */
  readonly noted: (note: string) => Effect.Effect<void>;
}

/** The state of each session the REPL follows at a terminal. */
const followers = Ref.makeUnsafe(HashMap.empty<Session, Following>());

/** The note printed after an answer that was cut short or interrupted. */
const cutNote = (ending: ReturnType<typeof endingOf>): string | undefined => {
  if (ending?._tag === "CutShort") return "(stopped: the response reached a length limit)";
  return ending?._tag === "Interrupted" ? "(interrupted)" : undefined;
};

/**
 * Returns what to print after a turn: the answer unless it already streamed (`printed`), with a note
 * if it was cut short; or how the turn ended if it gave no answer. Undefined when there is nothing
 * to add.
 */
export const replyOf = (facts: ReadonlyArray<Fact>, printed: (turn: TurnId) => boolean): string | undefined => {
  const turn = lastTurn(facts);
  const ending = endingOf(facts, turn);
  const answer = answerTo(facts, turn);
  const failure = failureOf(facts, turn);
  if (failure !== undefined) return errorLines(failure);
  if (answer === "") return ending?._tag === "Interrupted" ? "(interrupted)" : `(no answer: the turn ended ${ending?._tag ?? "with nothing recorded"})`;
  const cut = cutNote(ending);
  if (turn !== undefined && printed(turn)) return cut;
  return cut === undefined ? answer : `${answer}\n${cut}`;
};

/**
 * Prints the end of the session's last turn. For a session the REPL follows, the text has already
 * streamed: once the turn's updates are all printed, only the closing note is printed. For any other
 * session, the whole reply is printed.
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
 * Sends `input` as a turn and prints its end. During the turn the REPL reads the keys itself
 * (`turn-keys.ts`): Ctrl+C interrupts the turn, and Option+T shows or hides thinking.
 */
const turn = (session: Session, input: string, view: View) =>
  Effect.scoped(
    Effect.gen(function* () {
      const follower = Option.getOrUndefined(HashMap.get(yield* Ref.get(followers), session));
      if (follower !== undefined) {
        const { keys } = follower;
        const interrupted = yield* Deferred.make<void>();
        const toggled = yield* Queue.unbounded<void>();
        const key = (text: string) => {
          if (optionT.includes(text)) Queue.offerUnsafe(toggled, undefined);
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => keys.hold(() => Deferred.doneUnsafe(interrupted, Effect.void), key)),
          () => Effect.sync(keys.release),
        );
        yield* Effect.forkScoped(Deferred.await(interrupted).pipe(Effect.andThen(session.cancel), Effect.ignore));
        yield* Effect.forkScoped(Effect.forever(Queue.take(toggled).pipe(Effect.andThen(toggleThinking(view)), Effect.flatMap(follower.noted))));
      }
      yield* ask(session, input);
    }),
  ).pipe(Effect.andThen(printReply(session)));

/** Returns the input of tool call `call`, from the facts. */
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

/**
 * The permission question as shown. About a command: the command, then each of its programs that
 * needs permission and why. About a tool: the tool, its kind, and the call's input.
 */
const shown = (question: PermissionQuestion, input: string): string =>
  question._tag === "Command"
    ? [`Run this command? ${question.command}`, ...question.needs.map((each) => `  ${each.program}: ${each.why}`)].join("\n")
    : `Run ${question.tool} (${question.kind})? ${input}`;

/** Returns the first line of `text`, cut to `width` characters, and how many lines follow it. */
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

/** How an ended tool call is printed: the tool and its input, then how it ended. */
const shownEnded = (tool: string, input: string, outcome: ToolOutcome): string => `● ${tool} ${oneLine(input)}\n  \x1b[2m⎿ ${endedAs(outcome)}\x1b[0m`;

/** Returns the tool that `call` names, from the facts. */
const toolOf = (facts: ReadonlyArray<Fact>, call: CallId): string =>
  facts.flatMap((fact) => {
    if (fact._tag !== "Observed") return [];
    const observation = fact.observation;
    if (observation._tag === "ToolCallArrived" && observation.call === call) return [observation.tool];
    if (observation._tag === "ModelResponded") return observation.parts.flatMap((part) => (part._tag === "ToolCall" && part.call === call ? [part.tool] : []));
    return [];
  })[0] ?? "(a tool)";

/** Returns the text of an answer or thinking chunk, and which it is; undefined for any other update. */
const chunkOf = (update: SessionUpdate): { readonly kind: "answer" | "thinking"; readonly text: string } | undefined => {
  if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") return undefined;
  if (update.content.type !== "text") return undefined;
  return { kind: update.sessionUpdate === "agent_thought_chunk" ? "thinking" : "answer", text: update.content.text };
};

/**
 * Follows the session while the scope lasts. New facts and streamed deltas go into one queue and
 * through ACP's projection in live mode (`next`), starting from the projection of the facts already
 * recorded (`project`, replay mode), so nothing is printed twice. Prints answer text, and thinking
 * dimmed while `view` shows it; prints each tool call when it ends; asks each permission question;
 * and marks each turn's end once all its updates are printed.
 */
const following = (session: Session, view: View, stdin?: NodeJS.ReadStream) =>
  Effect.gen(function* () {
    const recorded = yield* session.subscribe;
    const streamed = yield* session.streamed;
    const inbox = yield* Queue.unbounded<ProjectionInput>();
    const before = yield* session.facts;
    const present = presentFrom(yield* immutableToolCatalogOf(before));
    const replayed = (yield* project(before, { mode: "replay", present })).state;
    const state = yield* Ref.make(replayed);
    // The turns whose updates are all printed: those that ended before following began, then each one as it ends.
    const taken = yield* Ref.make<ReadonlySet<TurnId>>(replayed.ended);
    // For each turn, a Deferred that completes when its updates are all printed; created on first use.
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
    const keys = turnKeys(stdin);
    const turnEnded = (turn: TurnId) => Effect.flatMap(Ref.get(taken), (ended) => (ended.has(turn) ? Effect.void : Effect.flatMap(endOf(turn), Deferred.await)));
    // The kind of text on the current unfinished line, if any.
    const open = yield* Ref.make<"answer" | "thinking" | undefined>(undefined);
    const write = (text: string) => Effect.sync(() => void process.stdout.write(text));
    const endLine = Effect.flatMap(Ref.getAndSet(open, undefined), (was) => (was === undefined ? Effect.void : write("\n")));
    const noted = (note: string): Effect.Effect<void> => Effect.andThen(endLine, write(`\x1b[2m(${note})\x1b[0m\n`));
    const follower: Following = { keys, turnEnded, noted };
    yield* Ref.update(followers, HashMap.set(session, follower));
    const printed = (update: SessionUpdate) =>
      Effect.gen(function* () {
        const chunk = chunkOf(update);
        if (chunk === undefined || chunk.text === "") return;
        if (chunk.kind === "thinking" && (yield* Ref.get(view.thinking)) === "off") return;
        if ((yield* Ref.get(open)) !== chunk.kind) yield* endLine;
        yield* Ref.set(open, chunk.kind);
        yield* write(chunk.kind === "thinking" ? `\x1b[2m${chunk.text}\x1b[0m` : chunk.text);
      });
    /** Handles a fact beyond printing text: prints an ended tool call, or asks a permission question. */
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
        // A defect in one input (a projection or a write that throws) is logged, and following continues.
        Effect.catchDefect((defect) => Effect.logError(logKeys.follow.inputFailed, { input: input._tag, cause: String(defect) })),
      );
    const forward = <A extends ProjectionInput>(subscription: PubSub.Subscription<A>) =>
      Effect.forever(PubSub.take(subscription).pipe(Effect.flatMap((item) => Queue.offer(inbox, item))));
    yield* Effect.forkScoped(forward(recorded));
    yield* Effect.forkScoped(forward(streamed));
    yield* Effect.forkScoped(Effect.forever(Queue.take(inbox).pipe(Effect.flatMap(take))));
  });

/** Describes a request an unfinished turn left running: a model request, a tool call and whether it started, or the turn-end review. */
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
 * The REPL's host at a terminal: it follows the session from the moment it opens, shows what `view`
 * allows, reads the keys of `stdin` (this process's by default) during a turn, and asks whether to
 * resume or end a turn that a previous run left unfinished.
 */
export const terminal = (view: View, stdin?: NodeJS.ReadStream): Host<Prompt.Environment | Services> => ({
  follow: (session) => following(session, view, stdin),
  choose: (left) =>
    Prompt.Select({
      message: `The last session stopped while ${left.turn} ran${left.stopping ? ", being interrupted" : ""}, with ${left.requests.map((request) => shownLeft(request, left.began)).join("; ") || "nothing under way"}. Go on with it?`,
      choices: [
        { title: "Go on with it", value: "go on" as const },
        { title: "End it, as interrupted", value: "end" as const },
      ],
    }).pipe(Effect.orElseSucceed(() => "end" as const)),
  wentOn: printReply,
});

/** What the REPL needs besides its session: the user's configuration folder, the view, and the settings given on the command line. */
export interface ReplContext {
  /** The user's configuration folder: `/model` and `/settings` write into it. */
  readonly configFolder: string;
  readonly view: View;
  readonly commandLine: SettingsChange;
}

/** Builds the commands' context: the working folder, the configuration layers, and the MCP servers. */
const commandContext = (context: ReplContext, layers: CommandContext["layers"], mcp?: McpServers): CommandContext => ({
  folder: process.cwd(),
  configFolder: context.configFolder,
  view: context.view,
  layers,
  commandLine: context.commandLine,
  ...(mcp === undefined ? {} : { mcp }),
});

/** Option+T at the prompt: shows or hides thinking, with a note saying which. */
const thinkingKey = (view: View): KeyBinding => ({ matches: isOptionT, run: toggleThinking(view) });

export const repl = (session: Session, config: Config, first: string | undefined, interactive: boolean, context: ReplContext, mcp?: McpServers) =>
  Effect.scoped(Effect.gen(function* () {
    yield* Console.log(`${config.target.provider}/${config.target.model} · /help for commands · /exit to quit · log: ${logFileOf(yield* Brand, config.sessionId)}`);
    if (first !== undefined) yield* turn(session, first, context.view);
    if (!interactive) return;
    yield* bracketedPaste;
    /** Reads and handles one line; returns whether to read another. */
    const step = Effect.gen(function* () {
      const input = yield* Multiline(completions(yield* offered(session, mcp)), [thinkingKey(context.view)]);
      if (input.trim() === "") return true;
      if (input.startsWith("/")) {
        // A command's error is printed, and the REPL continues.
        const done = yield* runInSession(session, input, commandContext(context, config.configuration.layers, mcp)).pipe(
          Effect.catchTag("UserError", (error) => Effect.succeed(said(String(error.userMessage)))),
        );
        if (done._tag === "Said") yield* Console.log(done.text);
        return done._tag !== "Exit";
      }
      yield* turn(session, input, context.view);
      return true;
    });
    yield* step.pipe(Effect.repeat({ while: (again) => again }));
  }));

/**
 * The REPL at a terminal before a model is picked, for a new session whose model cannot be used
 * (`problem`): none is set, its provider has no API key, or its server does not respond. No session
 * is open, so nothing is recorded. The REPL prints the problem, then reads lines:
 *
 * - A command that works without a model runs (`ReplCommand.withoutModel`). `/model` or `/switch`
 *   with a usable model returns that model, and the session opens with it; an unusable model is
 *   refused with the reason. `/exit` (or `/quit`) returns undefined.
 * - Any other command is refused until a model is picked.
 * - Any other input is not sent, and the REPL says why. `first`, a prompt given on the command line,
 *   is treated the same way.
 */
export const withoutModel = (problem: CannotAsk, first: string | undefined, context: ReplContext, layers: CommandContext["layers"]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const notSent = String(invalid(`Message not sent. ${problem.message}`, problem.hint).userMessage);
      yield* Console.log("No model selected · /model to pick one · /help for commands · /exit to quit");
      yield* Console.log(first === undefined ? String(saidOf(problem).userMessage) : notSent);
      yield* bracketedPaste;
      /** Reads and handles one line; returns the picked model, `exit`, or `again`. */
      const step = Effect.gen(function* () {
        const input = yield* Multiline(completions(yield* offeredWithoutModel), [thinkingKey(context.view)]);
        if (input.trim() === "") return "again" as const;
        if (!input.startsWith("/")) {
          yield* Console.log(notSent);
          return "again" as const;
        }
        // A command's error is printed, and the REPL continues.
        const done = yield* runWithoutModel(input, commandContext(context, layers)).pipe(Effect.catchTag("UserError", (error) => Effect.succeed(said(String(error.userMessage)))));
        if (done._tag === "Picked") {
          if (done.text !== undefined) yield* Console.log(done.text);
          return done.target;
        }
        if (done._tag === "Exit") return "exit" as const;
        if (done._tag === "Said") yield* Console.log(done.text);
        return "again" as const;
      });
      const ended = yield* step.pipe(Effect.repeat({ until: (outcome) => outcome !== "again" }));
      return ended === "exit" ? undefined : ended;
    }),
  );
