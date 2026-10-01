/**
 * The REPL: a prompt, the user's input to the model, its answer, and again, until `/exit`. A line
 * that starts with `/` is one of the REPL's own commands (`commands.ts`) and does not go to the model.
 * With input that is not a terminal there is nothing to prompt: it answers the first prompt, if one
 * was given, and ends.
 */

import { Console, Effect } from "effect";
import { Prompt } from "effect/cli";
import type { Fact } from "../../agent-machine/fact.ts";
import type { Session } from "../../agent-session/loop.ts";
import { command } from "./commands.ts";
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

export const repl = (session: Session, config: Config, first: string | undefined, interactive: boolean) =>
  Effect.gen(function* () {
    yield* Console.log(`${config.target.provider}/${config.target.model} · /help for commands, /exit to quit. Log: ${logFileOf(config.sessionId)}`);
    if (first !== undefined) yield* turn(session, first);
    if (!interactive) return;
    while (true) {
      const input = yield* Prompt.String({ message: "You" });
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
  });
