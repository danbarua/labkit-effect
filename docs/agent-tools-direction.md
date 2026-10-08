# Tools and their execution context: direction

Dan's direction for tools, the context they run in, and how they reach the model (2026-10-06). The
work is listed in order at the end. Text in quotation marks is Dan's, verbatim.

## The problem

- Each tool states and checks the same things itself:
  - Each workspace tool checks that its path is inside the working folder.
  - Each description repeated the working folder's path until the system text named it once.
  - ACP's editor world (`src/agent-acp/world.ts`) defines its own path check, with a different
    message.
- The git tools (`src/agent-tools/git.ts`) end every description with `Repository: <path>.`, and
  take paths relative to that repository. No host offers them.
- ACP shows a tool call's title as the tool's name and its command or path (`aboutOf`,
  `world.ts`). The model has no way to say what a call is for.
- `toolsOf` (`src/agent-session/tool-sources.ts`) stops the session with a defect when two tools
  have the same name, so no tool can replace another.
- What the tools run against (the working folder, the system text that names it, the tool sources)
  is ACP's `World`. The CLI builds its own from `workspaceTools`.

## Rulings

### A tool is a primitive, and each cross-cutting behaviour is a wrapper

- A primitive tool does one thing: `read_file` reads a file. It runs as the user, with no checks:
  "think of a bare tool as running in `yolo` permissions mode implicitly. Executes as the user. No
  guard rails."
- A wrapper is a function from a tool to a tool. It can change what the model is offered (the
  input schema and the descriptions), what happens before and after the inner tool runs, or both.
  Each behaviour is defined once, as one wrapper:

  | Wrapper | What it does |
  | --- | --- |
  | `inWorkspace` | Resolves relative paths against the working folder. The permission policy judges a path outside it, as it judges a command's (Dan, 2026-10-08: option B). |
  | `described` | Adds an `intent` input: one sentence that says what the call is for. A UI shows it as the call's title. The input is named `intent`, not `description`, because many tools (MCP tools among them) have a `description` input of their own. |
  | `bound` | Removes an input from what the model is offered, and supplies its value itself. The git tool bound to a workspace supplies `repository`: the model never sees that input. |
  | A permission check, a classifier | Decides whether a call runs. |
  | Where the tool runs (a container, a sandbox, a host over SSH) | Runs the call somewhere else. |
  | Code mode | Turns the tools into functions that a script calls. |

- A call can go through several wrappers of the same shape. "What if you want to require a user's
  permission **and** apply a classifier? (eg. enterprise deployment)?"
- `described`: when `described` wraps a tool, its `intent` input is required. When it does not,
  the tool has no `intent` input. A UI shows a call's intent when the call has
  one, and shows nothing for it when the call has none.
- MCP tools have no `intent` input for now. The MCP tools could later run through one generic
  runner, which a wrapper can wrap.

### Recorded facts are data

- A session's facts never stop it from continuing. When a wrapper is added or removed, the tools
  of the next turn are the tools as configured now.
- Telling the model that its tools changed is context assembly's job (below). "Whatever facts were
  recorded in the session journal are **data**, not a RefusalSource."

### Tools are configuration

- A tool is an extension: the harness's own code, or code that the user registered for the harness
  to run in its process.
- The built-in tools are a bundled plug-in that a configuration can leave out. The bare harness is a
  chat agent with no tools.
- Tools are configuration layers, merged in order. A tool with the same name as an earlier tool
  replaces it, and the replacement is logged at INFO. "anyone who's defining a tool `read_file` is
  doing so because they **want to** replace the `read_file` tool." This is a deliberate exception
  to the rule that a substitution is logged at WARN: the configuration is doing what it says.
- MCP servers can be configured for a project, as other harnesses do.

### The execution context

What the tools run against moves out of `agent-acp` into a module of its own (`agent-environment`
or `agent-tools-context`), which both hosts use. It holds:

- the working folder, and any folders added to it;
- the shell and its flavour (bash, zsh, sh), and the OS;
- the environment that commands run with;
- the file system and the process runner: local, a container, a host over SSH, or the editor's;
- the repositories in the workspace;
- the project's toolchain, from which a session can be offered tools such as `bun.test()` or
  `cargo.build()`;
- the limits: the bytes a result can carry, and a command's time.

Constraints:

- The limits are defined and configured once, not in each tool. A result that is over its limit is
  cut, and points to the whole output, for example `logs://bun/build/20261006171230.log`.
- An ACP session is bound to the editor's workspace.
- A CLI session can be resumed in another workspace, and moved back.
- The session's journal is separate from where its effects run. Dan: "The execution context could
  be a container running on GCP, or a Cloudflare tunnel back to my host Mac. It **doesn't really
  matter**, because we separated journalling of facts, decisions (intent) and the effects which are
  applied asynchronously."

### Context assembly

- What changes between turns (the repository's status, dependencies that changed, a webhook's
  event) is not part of the execution context. Each change is a notice for one turn. Compaction
  drops or squashes the notices, and may keep failed tool calls so that the model sees what it
  tried.
- The opening system prompt and tools need not be kept after compaction: the request's prefix is new
  then. `immutableToolCatalogOf` and `immutableSystemPromptOf` read the opening only; their dynamic
  counterparts are not written yet.
- How the model learns that its tools or its environment changed is a plug-in. It can be a list of
  the tools added and removed in the next user message, a rewritten opening, or a policy that
  compacts the conversation before a session moves.
- How notices are rendered depends on the model. A model that takes developer messages is sent
  them as developer messages. A model that does not is sent them inside the user message, in a
  rendering written for it. Each is a context assembler of its own.
- "We should be able to build a clone of contemporary harnesses as they run now, with their
  constraints, **and** we should be free to imagine a smarter more adaptable way of working".

### A tool's result has details for the harness (2026-10-08)

Dan: "Tool results with details: … Yes, that's the one." Built: a tool returns its text and, when it
has them, the details of what it did (`ToolOutput`, `ToolDetail`), which a successful outcome
records and the model is never sent (`docs/agent-machine.md`, `docs/agent-session.md`). The first
detail is `FileChanged`: a text file created, with its whole text, or updated, with a unified diff.
`write_file`, `edit_file`, `terminal_command` and `run_command` record it, a command for each file
whose text its words show (`writtenFiles`), its text read from the disk just before and after the
command runs (`recordingWrites`). ACP
shows a finished call's diffs from it, live and replayed alike, and the REPL prints them under the
call (`docs/agent-acp.md`). Other harnesses keep the same two parts per result: Claude Code's
`toolUseResult`, Codex's `FileChange`, opencode's `metadata`, omp's `details`.

The patch is kept with the result, in the facts, cut at 32 KiB at the end of a line, with the
bytes left out recorded (`cut`), as omp cuts its stored diffs. Dan: "There are diff tools (git, lol)
that handle big diffs." The REPL prints what was kept and how much was left out; there is nothing
past 32 KiB for it to expand.

**The tool runner reads the files (Dan, 2026-10-08).** "Yes, that way everything goes through the
trust layer (and we can enforce size limits in one place)." Not built. The design proposed:

- A wrapper around the session's tool runner finds the files a call will change from the same
  judgments the permission policy makes: a tool's path inputs (`ToolSpec.paths`) for a tool whose
  kind changes files, and the files a command writes text to (`writtenFiles`) for a command tool.
- It reads each file's text just before the call runs and once it has run, through a reader each
  world supplies: the editor's text for the editor's file tools, the disk for commands and the
  workspace's tools. It records `FileChanged` from the two, and holds the size limits (256 KiB read,
  32 KiB kept).
- The tools then return their text alone, and `recordingWrites` and the file tools' own reads go.

The other way, every tool's reads and writes through one files service, also sees what the agent
reads, which the harness's notices of changed files want, but it means rewriting every tool.

**Not built.**

- A `deleted` change: no tool deletes a file yet.

**Open.**

- A command's other changes, the files a program writes where its words do not show the text
  (`sed -i`, `mv`, a build), which say nothing once the call has ended. Dan: this would be an
  enhancement on "the agent ran this bash command", and git records the meaningful diffs anyway.
- Details tell the harness's notices of changed files which changes the agent made itself
  (`TODO.md`); Dan: "If we have the information to do so, then we should do so!"
- A rewritten search tells the agent that its command was rewritten and why in its result
  (`TODO.md`).

## Ideas, not decided

- `ToolCallPolicies` takes the shape of a wrapper.
- `--tools my_tools.ts`: tools given as code on the command line.
- `/preview`: the CLI shows what the next request would send, the system prompt included
  (`TODO.md`).
- A workspace wrapper under which the model is offered and sends only paths relative to the working
  folder, and the working folder's path is removed from results. The host (ACP) still sees absolute
  paths. Dan: "not necessarily something I'd use, but I can see enterprise deployments wanting it."
- Where a tool runs is a service that the tool asks for and the environment provides. The editor's
  tools already ask for `Editor`. `run_command` in the editor is a bare shell tool, run in the
  editor's terminal as its environment: "Run this bash command, but not over here, over *there*, in
  the editor's terminal shell".
- What a tool, or one action of a tool, does to the world, as data that the permission policy reads:
  MCP's tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) for
  each tool, or for each action of a tool with an `action` input. `agent-mcp/source.ts` already
  reads `readOnlyHint` into an MCP tool's kind and replay. The alternative is a tool for each
  action (`git_branch_list`, `git_branch_delete`).
- Large tool outputs are handled in one place, the tool runner, for every tool and environment.
  First: what ACP requires of an agent, and whether to adopt that generally. Explored, not decided:
  a result over its limit is cut, and points to the whole output, which the model reads in pages
  (`logs://tool_results/<call>`) or hands to a sub-agent to summarise. A session could also have
  a SQLite scratch database, written beside the JSONL journal, which code mode queries with SQL (full
  text search over the conversation, test reports gathered from tool calls).
- Code mode: a tool's name is a function's name, so names use `_`, not `-` (`git.do_thing()`). The
  git tools could be a virtual file system (`ls git://branch/`, `mv git://branch/a git://branch/b`,
  `head -n 5 git://remote/origin/main/log`), as omp's `XD://` is. How far a command-line
  experience maps onto "everything is a file" is not known; code mode is where to design it.

## Order of work

"define tools as they work in 90% of harnesses today: pinned at the top at the system prompt. Get
that nailed and robust first."

1. A tool as a value, and wrappers: `inWorkspace` and `described`, applied to the workspace tools.
   Built: `src/agent-tools/tool.ts`, `paths.ts`, `in-workspace.ts` and `described.ts`. ACP's
   editor tools are values too (`src/agent-acp/editor-tools.ts`), which ask for the `Editor`
   service that the world provides, and are wrapped the same way. A tool that reports on its call
   while it runs asks for `CurrentCall`, which `sourceOf` provides.
2. `bound`: the git tools bound to the workspace's repository. Built: `src/agent-tools/bound.ts`.
   Each git tool (`git.ts`) is a primitive that takes `repository`; `gitTools(root)` binds it to
   `root` and adds `intent`.
3. The git tools offered to sessions. Built: ACP's two worlds (`src/agent-acp/world.ts`) and the CLI
   (`src/examples/cli-repl/session.ts`) offer them when the working folder is a repository's root.
   In ACP they are a proof of concept of tools scoped to the host's environment: they work on the
   disk, not through the editor.

Not ordered yet: replacing a tool by name, the built-in tools as a bundled plug-in, and the
execution context as a module of its own.

After that, in this order, because each depends on the ones before it: forking, session identity,
compaction, cache-aware context, and dynamic tools. Then teams of agents that use different models.
