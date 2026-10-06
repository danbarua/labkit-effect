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
  | `inWorkspace` | Resolves relative paths against the working folder, and refuses a path outside it. |
  | `described` | Adds a `description` input: one sentence that says what the call is for. A UI shows it as the call's title. |
  | `bound` | Removes an input from what the model is offered, and supplies its value itself. The git tool bound to a workspace supplies `repository`: the model never sees that input. |
  | A permission check, a classifier | Decides whether a call runs. |
  | Where the tool runs (a container, a sandbox, a host over SSH) | Runs the call somewhere else. |
  | Code mode | Turns the tools into functions that a script calls. |

- A call can go through several wrappers of the same shape. "What if you want to require a user's
  permission **and** apply a classifier? (eg. enterprise deployment)?"
- `described`: when `described` wraps a tool, its `description` input is required. When it does
  not, the tool has no `description` input. A UI shows a call's description when the call has
  one, and shows nothing for it when the call has none.
- MCP tools have no `description` input for now. The MCP tools could later run through one generic
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

## Ideas, not decided

- `ToolCallPolicies` takes the shape of a wrapper.
- `--tools my_tools.ts`: tools given as code on the command line.
- `/preview`: the CLI shows what the next request would send, the system prompt included
  (`TODO.md`).

## Order of work

"define tools as they work in 90% of harnesses today: pinned at the top at the system prompt. Get
that nailed and robust first."

1. A tool as a value, and wrappers: `inWorkspace` and `described`, applied to the workspace tools.
2. `bound`: the git tools bound to the workspace's repository.
3. The git tools offered to sessions.

Not ordered yet: replacing a tool by name, the built-in tools as a bundled plug-in, and the
execution context as a module of its own.

After that, in this order, because each depends on the ones before it: forking, session identity,
compaction, cache-aware context, and dynamic tools. Then teams of agents that use different models.
