/**
 * The playground's exercises: prompts that make the agent run commands that the permission policy
 * judges differently, each with the command a model is expected to run, the folder the session starts
 * in, and what should happen. `make.ts` writes them into the playground's README files;
 * `exercises.test.ts` judges each command with the policy, so that what the README files say is what
 * the policy does.
 *
 * The playground (`make.ts`):
 *
 * ```text
 * labkit-playground/       not a git repository
 * ├── README.md            the exercises for a session started here
 * ├── app/                 a git repository
 * │   ├── README.md        the exercises for a session started in app/
 * │   ├── notes.md, config.yml, src/greet.py, src/sum.ts
 * │   ├── old.tmp, draft.tmp   tracked files to delete
 * │   └── build/           ignored by git
 * └── lib/                 a git repository
 *     ├── README.md        the exercises for a session started in lib/
 *     ├── secret.txt, data.csv
 *     └── build/           ignored by git
 * ```
 */

import type { NeedKind, PermissionMode } from "../../src/agent-policy/permissions.ts";

/** The folder a session starts in: the playground, or one of its repositories. */
export type Start = "." | "app" | "lib";

export interface Exercise {
  readonly start: Start;
  /** What to type to the agent. */
  readonly prompt: string;
  /** The command a model is expected to run for it. */
  readonly command: string;
  /** The permission mode the session is in; `default` when not given. */
  readonly mode?: PermissionMode;
  /** A command allowed for the rest of the session before this one. */
  readonly after?: string;
  /** Whether the command runs without a question, or is asked about. */
  readonly expect: "runs" | "asks";
  /** Why it is asked about, in the order the question names them. */
  readonly needs?: ReadonlyArray<NeedKind>;
  /** Whether the question offers to allow the program for the rest of the session. */
  readonly offersSession?: boolean;
  /** What to look for, in plain English. */
  readonly look: string;
}

export const exercises: ReadonlyArray<Exercise> = [
  {
    start: "app",
    prompt: "Show me the git status and the last three commits.",
    command: "git status && git log --oneline -3",
    expect: "runs",
    look: "Both run without a question: `git status` and `git log` only read.",
  },
  {
    start: "app",
    prompt: "Use sed to show lines 2 to 4 of notes.md.",
    command: "sed -n '2,4p' notes.md",
    expect: "asks",
    needs: ["notAllowed"],
    offersSession: true,
    look: "The question explains the sed script in plain English: it reads notes.md and prints lines 2 to 4.",
  },
  {
    start: "app",
    prompt: "With sed, change every 'colour' to 'color' in notes.md, editing the file in place.",
    command: "sed -i '' 's/colour/color/g' notes.md",
    expect: "asks",
    needs: ["notAllowed", "writes"],
    look: "The question says that sed edits notes.md in place, replacing every match of `colour` with `color`, and that it writes notes.md.",
  },
  {
    start: "app",
    prompt: "With a one-line python3 -c, print the squares of 1 to 5.",
    command: "python3 -c 'print([n * n for n in range(1, 6)])'",
    expect: "asks",
    needs: ["opaque"],
    look: "The question shows the Python code in a Python code block. Only this call can be allowed: labkit cannot tell what code will do.",
  },
  {
    start: "app",
    prompt: "Use python3 with a here-document to print the names of the files in src.",
    command: "python3 - <<'EOF'\nimport os\nprint(sorted(os.listdir(\"src\")))\nEOF",
    expect: "asks",
    needs: ["opaque"],
    look: "The question shows the here-document's code in a Python code block.",
  },
  {
    start: "app",
    prompt: "Using cat and a here-document, replace config.yml with two lines: `name: playground` and `debug: true`.",
    command: "cat > config.yml <<'EOF'\nname: playground\ndebug: true\nEOF",
    expect: "asks",
    needs: ["writes"],
    look: "In an editor, the call shows a diff of config.yml against its current text, and the question says the diff shows what the command writes. At the terminal, the question shows the diff.",
  },
  {
    start: "app",
    prompt: "Show me ../lib/secret.txt.",
    command: "cat ../lib/secret.txt",
    expect: "asks",
    needs: ["readsOutside"],
    offersSession: false,
    look: "`cat` reads outside the working folder, so it is asked about, and only this call can be allowed. Start a session in the playground folder and ask again: there it runs without a question.",
  },
  {
    start: "app",
    prompt: "Delete the build folder.",
    command: "rm -rf build",
    expect: "asks",
    needs: ["notAllowed"],
    offersSession: true,
    look: "The question offers to allow rm for the rest of the session. Choose that, then try the next prompt.",
  },
  {
    start: "app",
    prompt: "Now delete ../lib/build too.",
    command: "rm -rf ../lib/build",
    after: "rm -rf build",
    expect: "asks",
    needs: ["changesOutside"],
    offersSession: false,
    look: "Even with rm allowed for the session, deleting outside the working folder is asked about every time.",
  },
  {
    start: "app",
    prompt: "Make a scratch folder /tmp/labkit-playground, then remove it.",
    command: "mkdir -p /tmp/labkit-playground && rm -rf /tmp/labkit-playground",
    expect: "asks",
    needs: ["notAllowed", "changesOutside", "notAllowed", "changesOutside"],
    look: "The question names both programs: mkdir writes outside the working folder, and rm deletes outside it.",
  },
  {
    start: "app",
    prompt: "Delete every .tmp file that git tracks, using git ls-files and xargs.",
    command: "git ls-files -z '*.tmp' | xargs -0 rm",
    expect: "asks",
    needs: ["notAllowed", "notAllowed", "changesOutside"],
    look: "Both git ls-files and rm are asked about. rm gets its files from xargs, so labkit cannot see which files they are: the question says they may be outside the working folder.",
  },
  {
    start: "app",
    prompt: "Check that https://example.com answers, printing only the HTTP status code.",
    command: "curl -s -o /dev/null -w '%{http_code}' https://example.com",
    expect: "asks",
    needs: ["notAllowed"],
    offersSession: true,
    look: "curl is asked about, and can be allowed for the session. Writing to /dev/null is not writing a file.",
  },
  {
    start: "app",
    prompt: "Append the line 'hello' to notes.md with echo.",
    command: "echo hello >> notes.md",
    mode: "acceptEdits",
    expect: "runs",
    look: "In the acceptEdits mode, a command's writes to files in the working folder run without a question. In an editor, the call still shows the diff of notes.md.",
  },
  {
    start: "app",
    prompt: "Append the line 'hello' to /tmp/labkit-playground.log with echo.",
    command: "echo hello >> /tmp/labkit-playground.log",
    mode: "acceptEdits",
    expect: "asks",
    needs: ["changesOutside"],
    look: "Even in the acceptEdits mode, writing outside the working folder is asked about.",
  },
  {
    start: ".",
    prompt: "Show me lib/secret.txt.",
    command: "cat lib/secret.txt",
    expect: "runs",
    look: "Started here, lib/ is inside the working folder, so `cat` runs without a question.",
  },
  {
    start: ".",
    prompt: "What is the git status of app?",
    command: "git -C app status",
    expect: "runs",
    look: "`git -C app status` only reads, inside the working folder. This folder is not a git repository, so the agent has no git tools here and uses the command.",
  },
  {
    start: ".",
    prompt: "Delete app/build and lib/build.",
    command: "rm -rf app/build lib/build",
    expect: "asks",
    needs: ["notAllowed"],
    offersSession: true,
    look: "Both folders are inside the working folder: only rm itself is asked about, and it can be allowed for the session.",
  },
  {
    start: "lib",
    prompt: "Show me ../app/notes.md.",
    command: "cat ../app/notes.md",
    expect: "asks",
    needs: ["readsOutside"],
    look: "Started in lib/, app/ is outside the working folder.",
  },
];

const startName = (start: Start): string => (start === "." ? "the playground folder" : `${start}/`);

/** The exercises for sessions started in `start`, as Markdown. */
export const readmeOf = (start: Start): string => {
  const own = exercises.filter((exercise) => exercise.start === start);
  const others = (["app", "lib", "."] as const).filter((each) => each !== start);
  const item = (exercise: Exercise, at: number): string =>
    [
      `### ${at + 1}. ${exercise.prompt}`,
      "",
      `A model will probably run:`,
      "",
      "```sh",
      exercise.command,
      "```",
      "",
      ...(exercise.mode === undefined ? [] : [`Set the permission mode to **${exercise.mode}** first.`, ""]),
      `**${exercise.expect === "runs" ? "Runs without a question." : "Asked about."}** ${exercise.look}`,
      "",
    ].join("\n");
  return [
    `# labkit playground: sessions started in ${startName(start)}`,
    "",
    "Open this folder in your editor, start a labkit session, and type each prompt. The permission mode is",
    "`default` unless an exercise says otherwise. A model may run a different command than the one shown;",
    "the question names what it runs.",
    "",
    `Sessions started in ${others.map((each) => startName(each)).join(" and ")} have exercises of their own, some with the same prompts and other answers: see the README there.`,
    "",
    ...own.map(item),
  ].join("\n");
};
