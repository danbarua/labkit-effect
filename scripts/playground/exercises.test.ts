/** What the playground's README files say each exercise does is what the permission policy does with its command. */

import { expect } from "bun:test";
import { observe, open } from "../../tests/support/drive.ts";
import { test } from "../../tests/support/test.ts";
import { segmentsOf } from "../../src/agent-host/command-parser.ts";
import type { Fact } from "../../src/agent-machine/fact.ts";
import { CallId, ToolName } from "../../src/agent-machine/names.ts";
import { WordText } from "../../src/agent-policy/command-segments.ts";
import type { Folders } from "../../src/agent-policy/command-units.ts";
import { answerPicking, defaultPermissionSettings, OptionId, permissions, questionIn } from "../../src/agent-policy/permissions.ts";
import { receivedJson } from "../../src/agent-session/received.ts";
import { type Exercise, exercises, readmeOf } from "./exercises.ts";

const home = "/home/someone";
const playground = `${home}/Code/labkit-playground`;
const foldersOf = (exercise: Exercise): Folders => ({ working: WordText.make(exercise.start === "." ? playground : `${playground}/${exercise.start}`), home: WordText.make(home) });

/** The policy's first step for `command`, run by the ACP host's command tool, in `exercise`'s folder and mode, after `facts`. */
const stepOf = (exercise: Exercise, command: string, facts: ReadonlyArray<Fact>) =>
  permissions(exercise.mode ?? "default", true, () => "execute", facts, { settings: defaultPermissionSettings, segmentsOf, folders: foldersOf(exercise) }).start({
    _tag: "RunTool",
    call: CallId.make("c1"),
    tool: ToolName.make("terminal_command"),
    input: receivedJson({ command }),
  });

/** A session in which `command` was asked about and allowed for the rest of the session. */
const allowedFor = (exercise: Exercise, command: string): ReadonlyArray<Fact> => {
  const step = stepOf(exercise, command, []);
  if (step._tag !== "Waiting" || step.asks === undefined) throw new Error(`${command} was not asked about`);
  const session = open();
  observe(session, { _tag: "PermissionAsked", call: "c1", asks: step.asks });
  observe(session, { _tag: "PermissionAnswered", call: "c1", answer: answerPicking(OptionId.make("allow-session")) });
  return session.journal;
};

test("each exercise's command runs or is asked about as its README says, for the reasons it gives", () => {
  for (const exercise of exercises) {
    const step = stepOf(exercise, exercise.command, exercise.after === undefined ? [] : allowedFor(exercise, exercise.after));
    const question = step._tag === "Waiting" && step.asks !== undefined ? questionIn(step.asks) : undefined;
    const judged = {
      prompt: exercise.prompt,
      outcome: step._tag === "Decided" && step.verdict._tag === "Continue" ? "runs" : question === undefined ? "vetoed" : "asks",
      ...(exercise.needs === undefined ? {} : { needs: question?._tag === "Command" ? question.needs.map((need) => need.kind) : [] }),
      ...(exercise.offersSession === undefined ? {} : { offersSession: question?.options.some((option) => option.kind === "allow_always") ?? false }),
    };
    expect(judged as unknown).toEqual({
      prompt: exercise.prompt,
      outcome: exercise.expect,
      ...(exercise.needs === undefined ? {} : { needs: exercise.needs }),
      ...(exercise.offersSession === undefined ? {} : { offersSession: exercise.offersSession }),
    });
  }
});

test("each folder's README lists its exercises, with the command a model will probably run", () => {
  const app = readmeOf("app");
  expect(app).toStartWith("# labkit playground: sessions started in app/");
  expect(app).toContain("### 1. Show me the git status and the last three commits.");
  expect(app).toContain("```sh\nsed -n '2,4p' notes.md\n```");
  expect(readmeOf(".")).toContain("### 1. Show me lib/secret.txt.");
});
