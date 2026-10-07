/**
 * Makes the permission playground: a folder that is not a git repository, with two git repositories
 * in it (`app/` and `lib/`) and a README in each folder listing exercises for a session started there
 * (`exercises.ts`):
 *
 *   bun run playground:make [folder]
 *
 * The folder is `~/Code/labkit-playground` when none is given. It must not exist yet: the script does
 * not delete or replace files. The exercises change files only inside the playground and under
 * `/tmp/labkit-playground`.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readmeOf } from "./exercises.ts";

const folder = resolve(process.argv[2] ?? join(homedir(), "Code", "labkit-playground"));
if (existsSync(folder)) {
  console.error(`ERROR: ${folder} already exists.`);
  console.error("HINT: Delete it to make it again, or name another folder: bun run playground:make <folder>.");
  process.exit(1);
}

const intro = `# labkit playground

A folder for trying labkit's permission questions. It is not a git repository; \`app/\` and \`lib/\` are.
Each folder's README lists prompts for a session started there. The same prompt can give another
answer in another folder: \`lib/secret.txt\` is inside a session started here, and outside one started
in \`app/\`.

## Opening it

- **VS Code:** from a labkit checkout, run \`bun run vscode:dev ${folder}\`. VS Code opens this folder
  with that checkout's agent. Run it from a branch's worktree to try the branch.
- **JetBrains Air:** open this folder. The agent is the one your Air settings launch
  (\`~/.jetbrains/acp.json\`).
- **The terminal:** \`cd\` into a folder and run labkit's CLI there.

To start a session in \`app/\` or \`lib/\`, open that folder on its own: a session's working folder
is the folder the editor opened.

The agent reads its model provider's key from its environment: \`ANTHROPIC_API_KEY\`,
\`OPENAI_API_KEY\` or \`XAI_API_KEY\`. Give it one in the editor's agent settings, start the editor
from a shell that has one, or choose a local model, which needs none.

The exercises change files only inside this folder and under \`/tmp/labkit-playground\`. Run them in
the \`default\` permission mode unless an exercise says otherwise, and not in \`bypassPermissions\`.

`;

const files: Readonly<Record<string, string>> = {
  "README.md": `${intro}${readmeOf(".").replace(/^# .*\n/, "## Exercises for a session started here\n")}`,
  "app/README.md": readmeOf("app"),
  "app/.gitignore": "build/\n",
  "app/notes.md": "# Notes\nThe colour of the button is blue.\nThe colour of the header is grey.\nChoose a colour for the footer.\nShip it.\n",
  "app/config.yml": "name: app\ndebug: false\n",
  "app/src/greet.py": 'print("hello from app")\n',
  "app/src/sum.ts": "export const sum = (numbers: ReadonlyArray<number>): number => numbers.reduce((total, each) => total + each, 0);\n",
  "app/old.tmp": "an old scratch file\n",
  "app/draft.tmp": "a draft scratch file\n",
  "app/build/output.txt": "built\n",
  "lib/README.md": readmeOf("lib"),
  "lib/.gitignore": "build/\n",
  "lib/secret.txt": "This is not a real secret. A session started in app/ is asked before it reads this file.\n",
  "lib/data.csv": "name,count\napples,3\npears,5\nplums,8\n",
  "lib/build/cache.txt": "cached\n",
};

for (const [path, text] of Object.entries(files)) {
  mkdirSync(dirname(join(folder, path)), { recursive: true });
  writeFileSync(join(folder, path), text);
}

for (const repository of ["app", "lib"]) {
  const git = (...args: ReadonlyArray<string>) => {
    const ran = Bun.spawnSync(["git", "-c", "user.name=labkit playground", "-c", "user.email=playground@localhost", "-c", "init.defaultBranch=main", ...args], { cwd: join(folder, repository), stderr: "pipe" });
    if (ran.exitCode !== 0) {
      console.error(`ERROR: git ${args.join(" ")} failed in ${join(folder, repository)}: ${ran.stderr.toString().trim()}`);
      process.exit(1);
    }
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", `The ${repository} repository of the labkit playground`);
}

console.error(`Made the playground in ${folder}.`);
console.error(`Open it in VS Code: bun run vscode:dev ${folder}`);
