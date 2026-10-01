/**
 * The REPL: a prompt, the user's input to the model, its answer, and again, until `/exit`. A line
 * that starts with `/` and names a command is the REPL's own and does not go to the model. With
 * input that is not a terminal there is nothing to prompt: it answers the first prompt, if one was
 * given, and ends.
 */

import { Console, Effect } from "effect";
import { Prompt } from "effect/cli";
import type { Fact } from "../../agent-machine/fact.ts";
import type { Session } from "../../agent-session/loop.ts";
import { answerTo, ask, type Config, endingOf, lastTurn, logFileOf } from "./session.ts";

/** What is printed after a turn: the answer, or how the turn ended when it gave none. */
const replyTo = (facts: ReadonlyArray<Fact>): string => {
  const turn = lastTurn(facts);
  const ending = endingOf(facts, turn);
  const answer = answerTo(facts, turn);
  if (ending?._tag === "Failed") return `(the turn failed: ${ending.failure})`;
  return answer !== "" ? answer : `(the turn ended ${ending?._tag ?? "with nothing recorded"}, with no answer)`;
};

/** The REPL's own commands, and what each says of itself in `/help`. */
const commands: ReadonlyArray<readonly [string, string]> = [
  ["/help", "Show these commands"],
  ["/exit", "Quit (also /quit)"],
];

const turn = (session: Session, input: string) =>
  ask(session, input).pipe(
    Effect.andThen(session.facts),
    Effect.flatMap((facts) => Console.log(replyTo(facts))),
  );

export const repl = (session: Session, config: Config, first: string | undefined, interactive: boolean) =>
  Effect.gen(function* () {
    yield* Console.log(`${config.target.provider}/${config.target.model} · /help for commands, /exit to quit. Log: ${logFileOf(config.sessionId)}`);
    if (first !== undefined) yield* turn(session, first);
    if (!interactive) return;
    while (true) {
      const input = yield* Prompt.String({ message: "You" });
      if (input === "/exit" || input === "/quit") break;
      if (input.trim() === "") continue;
      if (input === "/help") {
        yield* Console.log([...commands.map(([name, says]) => `${name.padEnd(7)}${says}`), "Anything else goes to the model."].join("\n"));
        continue;
      }
      yield* turn(session, input);
    }
  });
