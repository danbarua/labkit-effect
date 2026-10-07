# To do

What is to be built, by capability. What is built is described in `docs/<module>.md`; direction that
is not yet work is in `docs/<module>-direction.md`. Delete an item when it is done or dropped. As of
2026-10-07.

## Build

### The hosts: ACP and the CLI

Both hosts are built here, and labkit imports the libraries from here. The core is the mediator
between a host and the models (machines, messages, streams of events): the workspace, the working
folder, the tool catalog, the configuration UI and what a session is called are the host's.

ACP: the protocol is built, as a package of its own (`effective-acp`,
github.com/danbarua/effective-acp: schemas, the peer, stdio and Streamable HTTP, negotiation; its
`src/MODEL.md`, and `src/EFFECT-FIT.md` for where Effect fits). The host, which joins it to the
session, is built for protocol v1 over stdio (`src/agent-acp`, `bun src/agent-acp/main.ts`;
`docs/agent-acp.md`). It runs in VS Code with labkit-web's client (`bun run vscode:dev`), and has
run the scenario below against the local Qwen with the SDK's client. The JetBrains AI extension
(PyCharm, WebStorm) comes next. The protocol versions and features are those of the labkit
monorepo's ACP host, for parity; what `session/load` sends back is the ACP side's to decide. In ACP,
tools go through the editor.

Dan's rulings about the hosts and the order of work are in `docs/agent-host-direction.md`.

A real ACP session's log
(`~/.labkit/logs/acp-44517-ec9d22b3-8c0d-465a-83c7-9c227e0aec77.jsonl`, labkit-agent, local Qwen)
is the set of capabilities a first working host needs: choose a model and a thinking level, send
the first input, stream thinking, the model calls a tool, the user is asked for permission, the
tool runs, the model answers, and `/export` writes the session to Markdown without going to the
model.

- [ ] Tool permission. Built: each tool call goes through `ToolCallPolicies` in the loop; the
      permission modes (`default`, `acceptEdits`, `dontAsk`, `bypassPermissions`) by each tool's
      kind; what is asked and answered recorded (`PermissionAsked`, `PermissionAnswered`); allow
      for the session read from the facts; the CLI's `--permission-mode` and its REPL question;
      for ACP, the `session/request_permission` request and its answer, where the client's
      cancelled outcome is a refusal (`src/agent-acp/permission.ts`), asked by the host's feed; the
      mode as an ACP option the user changes (`permission_mode`), from the next turn. To do: `plan`
      and `auto`; rules by other tools' arguments (`write_file`'s path); resetting permissions; a change of
      mode recorded in the session's facts (the ACP host keeps it only while the session is open).
      - `run_command` (the CLI's and the ACP host's) runs any shell command, and permission is
        given per tool: "Allow for the rest of the session" on one call allows every command
        after it (`rm`, `git push`, `curl … | sh`), and `bypassPermissions` runs them all
        unasked.
      - Permission by command. Built (`docs/agent-policy.md`, Rules and Command tools): the Rust
        crate `native/bash-segments` (brush-parser, adapted from exo-project's spike 01_2) splits a
        command into every program it would run, as WebAssembly the host loads
        (`agent-host/command-parser.ts`); `command-units.ts` reads past wrappers, follows code
        written out for `bash -c` and `eval`, and marks what is opaque; allow and deny rules
        (`<tool>(<words>:*)`, `command(…)` for every command tool), the read-only programs, grants
        for the rest of the session (program and subcommand, script or package), and redirects to
        files needing `acceptEdits`. Session answers apply in `dontAsk` and headless mode. A question
        shows what a `sed` script does, in plain English, and code written in the command in its
        language. To do:
        - Changes outside the working folder (built: writes, `rm`, `mv`, `cp`, `chmod`, `touch`,
          `curl -o`, `find -delete`, `xargs rm`, and the like) are lifted by an allow rule naming
          the program. To do: rules that name paths (`command(rm:/tmp/*)`, Dan, 2026-10-07), refused
          until then; the programs the guide lists as not checked (`docs/guide/permissions.md`).
        - Jev classifies what the rules cannot decide, from the exo-project skeleton (`01_3`).
        - Models are told to use the write and edit tools instead of `python -c` and heredocs.
        - A here-document's body fed to a shell (`bash <<'EOF'`) is opaque; it could be split as
          `bash -c` is.
        - The JSON Schema does not carry the rules' pattern; a rule that is not valid is refused when
          the configuration is read.
        - Measured (`docs/bash-segments.md`, Measuring the policy): over 85,042 commands from
          542 Claude Code, Codex and omp sessions (2026-10-07), 15.4% run without a question when
          first in their session and 46.8% with every grant offered allowed for its session. The
          questions that offer only the call are mostly reads outside the working folder (27,664:
          paths not written out, sibling projects under `~/Code`, `/tmp` and Claude Code's
          scratchpad), files written (15,784), code read from input (12,367) or written in the
          command (5,039), and `awk` (1,695). By model, the share that runs without a question in
          its session ranges from 3% (Sonnet 5 under omp) to 80% (Sonnet 5.5 under Claude Code);
          `ask-rate` prints the table. 24,726 commands, from transcripts that no longer exist, have
          no model recorded; `ask-rate` reports them as Claude's (from Claude Code) or OpenAI's (from
          Codex).
        - A file a command writes is shown as a diff (built: the editor's call and the REPL's question).
          To do: the REPL shows no diff for a write it does not ask about (`acceptEdits`), since its
          command tool does not read the file before it runs; the local tools' world
          (`--local-tools`) shows none; `printf` and `sed -i` are not shown as diffs.
        - Code is shown as written: a one-line `python3 -c '…; …'` stays on one line. Formatting it
          (Python's `ast.unparse`, a JavaScript formatter) would run a program on the host.
        - `awk` judged by its program, as `sed` is (no `system()`, no pipes, no `print >`).
        - Git judged by its action, as `sed` is by its script: which git actions read, which write
          the working tree or the history, and which reach a remote (Dan, 2026-10-07).
        - A temporary folder for each session (Dan, 2026-10-08): a private folder the agent may
          write anything to without a question, named by a virtual URL (`tmp://`, as omp's
          `local://`), and counted as inside the working folder. Writing to `/tmp` and the like is
          asked about. Whether the folder's files are kept or deleted is the operator's choice, not
          the agent's: a "throw-away" script often turns out to be the work (labkit's exploratory
          science). Setting `TMPDIR` in the commands' environment (`commandEnvironment`) puts
          `mktemp` and Python's `tempfile` there with no change in how agents work. It replaces the
          isolated temporary folder for each agent (2026-10-07), opt-out included. Virtual URLs need
          commands' paths found, which `command-units.ts` does.
        - Tool results with details (Dan, 2026-10-08): a result has the text the model sees and
          details for the harness and its displays, which the model never sees, as Claude Code's
          `toolUseResult`, Codex's `FileChange`, opencode's `metadata` and omp's `details` do. A
          file change's details are its patch (Codex's size: the diff for an update, the content for
          a new file), stored with the result (large ones in the blob store), so a loaded session
          shows the same diff as the live one, `write_file` and `edit_file` included, and a
          replayed command's "Wrote config.yml." goes. To write up first, in
          `docs/agent-tools-direction.md`, then build.
        - The opinionated harness runs a composite command itself (Dan, 2026-10-07): it splits the
          command into its programs and their order, runs each, and returns to the model the result
          the command asked for (the output of `… | tail`), with each program's exit code and a
          pointer to its full output. Every program's run is then recorded, for audit and for
          analytics over a project's commands.
      - The ACP host's command tool, `terminal_command`, runs in the editor's terminal
        (`terminal/create`), with the environment the editor gives it.
      - Later (Dan, 2026-10-07):
        - git as the record of what agents change in files, rather than the session's facts (Dan,
          2026-10-07): a snapshot commit after each tool call, in a repository of the harness's own,
          so that it works in a folder that is not a git repository (Gemini CLI's checkpointing:
          `~/.gemini/history/<project hash>`, and `/restore`). A past call's diff is a diff between
          two commits, and a session records only their ids. It gives `/undo` and `/rewind`, and,
          git being a content-addressed tree, a way to fork and branch sessions with their files
          (Forks, under Sessions). Open: how much it grows, against the session's facts.
        - The harness as the broker between agents and the environment (Dan, 2026-10-07). A
          `git push` run in a terminal and a `git_push` tool are the same request, and the harness
          decides whether (permissions) and how (the tool runner) it happens, so it can add to it:
          a git note naming the session (`<session>@labkit`) on each commit an agent made, pushed
          with the commits (`refs/notes/*`, which git does not push by itself). With its own record
          of which agent committed, pushed, opened a pull request or commented, it can match
          GitHub's webhooks to agents: not telling an agent about its own comment or pull request,
          telling it about a push by someone else to its pull request's branch. What is built today
          outside it (MCP servers, a webhook peer, a daemon compiling digests) becomes the harness's,
          and agents see only timely, relevant notifications. A commit trailer naming a Claude Code
          cloud session is no use for this: only Anthropic can resolve it to a local session.
          A note belongs to one commit id: a squash or rebase merge on GitHub makes new commits
          without it, and a local rebase or amend drops it unless `notes.rewriteRef` copies it. That
          is wanted: notes mark work in progress on a pull request's branch. What follows a merge
          (comments on it, a revert, a failing build on `main`) names the pull request by number,
          which the harness records when it opens one.
        - Webhook delivery (Dan, 2026-10-07): an extension and a sidecar daemon at the harness's
          layer, not MCP servers and polling. The daemon is started by the first session that needs
          it, shared, and stops when none has needed it for a while (Effect's `RcRef` and `RcMap`
          do this within one process: acquired on first use, released after `idleTimeToLive`). It
          receives GitHub's webhooks through a Cloudflare tunnel: `labkit.cloud`, or a temporary
          `*.trycloudflare.com` tunnel whose lifetime is a scoped resource like an MCP server's. A
          long-running session trusted to do so could set up its own repositories' webhooks and its
          own tunnel. Deliveries are current only: when this machine is offline, no one is working,
          so there is no queue of stale deliveries (unlike agent-bridge's message queue with TTLs).
        - A command whose effect is an edit to a file (`cat > f <<'EOF'`, `sed -i`) dispatched to
          the edit tools, so that it goes through what they check and report: refusing an edit to
          text that was not read, or to a file changed since it was read, and the editor's record of
          a turn's edits (JetBrains Air's ACP extension, for review and comments).
        - Git subcommands that can lose uncommitted work (`git stash`, `git reset`,
          `git checkout`, `git rebase`), which today are `edit` tools and run unasked under
          `acceptEdits`.
        - Allowed and denied tools per MCP server, to choose which tools are offered and which
          can be called. Today an MCP tool's `readOnlyHint` alone makes it run in every mode.
- [ ] Accounting for ACP. Built: a provider-neutral `usage` on each response; `contextGauge` (used,
      size, cost) read from the facts (`accounting.ts`) and `requestsIn` (a turn's model requests,
      `src/agent-machine/turn-requests.ts`); prices with the well-known models; `maxTurnRequests` as
      an example host policy; for ACP, `usage_update` and a turn's stop reason, where a vetoed
      request is `max_turn_requests` and a cut-short response `max_tokens` (`src/agent-acp/usage.ts`,
      `stop-reason.ts`), with a `notice` that explains a stop of `max_tokens` or `refusal` (the
      model, the output tokens used and the output limit sent, or the provider's stop reason and its
      refusal text), sent before the answer to a client that advertised `session.notices`, never
      replayed. The session's feed sends `usage_update` when the numbers change (after a
      response, a change of model taken, a turn's end, before the prompt's answer) and after
      `session/load` and `resume`, never twice in a row with the same numbers, and with no `cost`
      while no response of the session was priced. Open: after a compaction `used` is the last
      response's until the next one reports (an estimate would come from the next-request size
      estimate); a summarizer's own requests are not counted in `cost`. `PromptResponse.usage` is a
      draft; not built.
- [ ] Attachments. Built: input carries files by reference (`InputArrived.attachments`); a tool's
      output that arrives as bytes is kept in the blob store and recorded by reference (`Received`
      body `Stored`); bytes in the blob store (`Blobs`: in memory by default, or a folder); each
      adapter sends images and PDFs as its provider takes them, in a user message or a tool result,
      a text file as its text, and anything a model is not known to take as a pointer, logged;
      counting a request's input before it is sent (`anthropic-count.ts`, `openai-count.ts`; xAI has
      no endpoint). Live: all three read an attached image and PDF, and an image a tool returned;
      the counts before sending matched what the responses reported; the ACP host takes a prompt's
      images and embedded files into the session's blob store, kept in its folder. Left: the
      client half (sending, drawing, resolving `blob://`), labkit-web's.
- [ ] The host's services, shared by the CLI and the ACP host (`src/agent-host`). Built: the model
      catalog, the provider clients, the services a session runs with, the permission policy for a
      mode, where a host keeps its sessions and logs (`~/.local/share/<brand>/`), log lines to a file
      or to stderr and, with `OTEL_EXPORTER_OTLP_ENDPOINT` set, as OTLP with the spans and metrics,
      the ACP launcher's log file (JSONL, rotated, secrets redacted; `bun run acp:logs`), the host's
      own record of a session in its folder (`host.json`, stored and returned as JSON), and
      `withSession`, which runs a session with what a host adds to it (the CLI's tools and MCP
      servers, zork's game) (`docs/agent-host.md`). To do: a hand-written `models.yml` as one more
      source of the catalog. Open: the ACP host opens its sessions itself, not through `withSession`.
- [ ] `session/update`. Built: the projection of a session's facts and of the core's captured items
      (`ModelDelta`, `ModelPartArrived`, `ModelResponseEnded`), merged in any order, to the client's
      updates, one function for the live view and for `session/load` (`src/agent-acp/projection.ts`),
      which the ACP host's feed sends: text and thinking as they arrive, tool calls and how they
      end; `session/load` sends the projection of the stored facts before its answer, each response
      before the calls it made, as live sent them, and the feed goes on from the state they leave;
      the model's plan (`update_plan`) as a `plan` update; each text chunk's message (`messageId`: a
      user's input by its seq; a run of one kind of text in a response by its request's first
      dispatch and the run's place), the same live and on `session/load`; each call's tool name,
      input and raw output (`name`, `rawInput`, `rawOutput`). To do: the last plan sent again on
      `session/load`; an input's attachments sent on `session/load`; `current_mode_update` (the host
      offers the permission mode as a config option instead). Open: live with no deltas (a server
      that answers whole) announces a call before its response's text, which is known only when the
      response ends; the host's own replies to `/export` and `/mcp` carry no `messageId`.
- [ ] The ACP host's sessions across processes. Built: each session's facts in a file
      (`FileBackedSessionStore`, `~/.local/share/labkit/sessions/v0.1.0`); the host's record of a
      session (`host.json`: the ACP host, the working folder, a title from the first prompt), written at turn zero; `session/load` (the
      stored facts replayed before the answer), `session/resume` (no replay) and `session/list`
      (by working folder, newest first, paged), with `session_info_update`; a turn the facts left
      running is ended, not gone on with; `session/close`. To do: `session/fork` (it waits for the
      core: Forks, under Sessions); `session/delete`; additional directories. Open: the permission
      mode is not in the host's record, so a reopened session starts at the launcher's mode; ACP has
      no update for how a turn ended, so a replay of a turn that ended without an answer
      (interrupted, failed) shows what its finished requests sent and nothing of how it ended.
- [ ] The ACP host in JetBrains. In VS Code (labkit-web's client, `bun run vscode:dev`; 2026-10-07):
      the session's config options as selects (permission mode, model, effort), its title from the
      first prompt, a tool call and how it ended, the answer, and the context gauge and cost from
      `usage_update`.
- [ ] MCP servers. Built (`src/agent-mcp`, on `src/agent-process`): the client over stdio, Streamable
      HTTP and HTTP+SSE (`type: http`, `sse`, with `url` and `headers`; `${VAR}` in a server's
      configuration); each server a machine over its runs (a process, or a session at its URL, made
      anew when the server drops it), `NeedsAuth` when it asks for credentials none are given or for
      OAuth; the ACP host starts the servers a client names,
      offers their tools after the world's under `mcp__<server>`, tells the model of one not
      running, records their states (`McpServerChanged`), and serves `/mcp` and
      `/mcp reconnect <server>`; the CLI starts the servers its configuration names (its files,
      `--mcp-config`), and one marked `required: true` that does not connect keeps the session from
      opening; `/mcp` in the REPL, with completions; the ACP host reading each session's
      configuration, the client's servers over the configuration's by name, a required one that
      does not connect refusing the session; the ACP host advertising `mcpCapabilities.http` and
      `.sse`. To do: OAuth for a server that asks for it (the authorization code flow with PKCE, the
      token kept and refreshed), now `NeedsAuth`; resuming a Streamable HTTP stream that broke off
      (`Last-Event-ID`); MCP over ACP (`mcpCapabilities.acp`); the REPL's completions and hints from
      a machine of the command line's state; tools a server offers
      after the session opened (after a reconnect, or `notifications/tools/list_changed`), with
      per-turn tool lists; sampling and elicitation; a result's images and audio sent to the model
      as images and audio where its provider takes them in a tool's result (Anthropic's does), not
      as a line naming them.
      Effect's `RpcClient` over `McpSchema.ClientRequestRpcs`, through a transport of our own over
      a child's stdio, against `@modelcontextprotocol/server-everything` (2026-10-03): `initialize`,
      `tools/list` and `tools/call` work. It sends a notification with an id (the server answers
      -32601, and without `initialized` it does not offer its sampling, elicitation and roots
      tools); a request from the server (`roots/list`, `sampling/createMessage`) and a notification
      (`notifications/tools/list_changed`, `notifications/message`) are dropped, so the call that
      led to the request waits for ever; cancelling sends `@effect/rpc/Interrupt`, not
      `notifications/cancelled`; and fields its schemas do not have are dropped (`tasks`, a tool's
      `execution`). These are `effective-acp`'s reasons for its own JSON-RPC peer
      (`EFFECT-FIT.md`), so the client is built on a copy of that peer, with `McpSchema`'s schemas.
- [ ] The ACP host over Streamable HTTP (`Agent.layerHttp`), with a token and one holder for a
      session, for labkit-web.

### Configuration

- [ ] Trusted folders (Dan, 2026-10-04 and 2026-10-07). Built (`docs/agent-config.md`,
      `agent-host/trust.ts`): the trusted folders listed in `trusted-folders.json` in the user's
      configuration folder, a folder inside a listed one trusted too; the `labkit` command
      (`bin/labkit.ts`), which Bun starts without the folder's `.env` and `bunfig.toml`, asks at a
      terminal whether to trust a folder that has `.env` files or `.labkit/`, and starts the CLI with
      the folder's `.env` only when it is trusted, never with its `bunfig.toml`; a project's files,
      when `--setting-sources` names them, read only in a trusted folder and then trusted (so they
      may name extensions and MCP servers); for the ACP host, the session's folder trusted, the
      editor's workspace trust being the boundary; a relative `--config-dir` refused. To do:
      - Trusting or no longer trusting a folder without a terminal: today the list is edited by hand.
      - `bun cli` and the entry files run directly read the folder's `.env` and `bunfig.toml`, as Bun
        does; only `labkit` keeps them out. The ACP launcher reads its spawn folder's, which the
        editor chooses.
      - The hints that name `bun cli` (`bun cli models lists the models you can use.`) are to name
        the command the user ran.
- [ ] Turn-end hooks by name, as policies are: a hold recorded from the hook that made it, so
      `retryIncomplete` counts its own holds, not every hook's. Today `holdsOf`
      (`agent-session/turn-holds.ts`) counts every hook's holds, for the loop and for zork's
      adventurer.
- [ ] The product's name (Dan is thinking of `whitelabel-agent`): the default brand
      (`agent-host/brand.ts`) is still `labkit`, and with it the meta variable
      (`LABKIT_BRAND`).

- [ ] Plug-ins and their configuration (Dan's decisions, 2026-10-03 and 2026-10-05;
      `docs/agent-config.md`). Built: a plug-in declares a Schema for its settings, with a default
      for each, and the seams it adds entries to (`toolCalls`, `modelRequests`, `turnEnd`,
      `knownModels`, `settling`, `toolSources`, `commandEnvironment`); one ordered list per seam, each
      entry a plug-in's name or `use: <name>` with its settings, decoded against the plug-in's
      Schema, refusing properties it does not have, and a plug-in on two seams listed in each; a
      setting that is a function named in the file (the loop breaker's `key: toolAndInput`);
      extensions, modules the user's file names, loaded before the entries are decoded; the files
      read with Effect's YAML; every `.yml` file in the configuration folder, in name order; a JSON
      Schema made from the same Schemas, for editors; the entry that vetoed named in the origin and
      the log. To do:
      - A session's plug-ins and settings recorded in its facts when it opens; the file is what new
        sessions start with. Today the CLI writes what its configuration resolved to beside the
        facts (`effective-settings.json`).
      - A change to them observed (a draft) and taken (admitted) only between turns, when the
        machines have settled. A user who wants it sooner cancels the turn. Today the configuration
        is read when a session opens; a change of model, and the ACP host's permission mode, are
        already taken between turns.
      - The entry that held a turn named (turn-end hooks by name, above).
      - Information providers (the notices a request carries, `Notices`) as a seam that a plug-in
        adds to.
- [ ] Later (Dan, 2026-10-03): a change that tightens the permission mode taken between the steps
      of a turn, delivered through the inbox as steering is.
- [ ] Parked (Dan, 2026-10-03): permission in headless mode (`-p`), where no one can answer a
      question: allow and deny lists by tool and argument (Claude Code's `--allowedTools`,
      `--disallowedTools`), or a tool that answers permission questions (its
      `--permission-prompt-tool`, an MCP tool). Today such a call is vetoed, the reason saying how
      to let it run.
- [ ] Withdrawing input queued for a turn that has not been delivered: the core does it
      (`InputCancelled`, agent-machine `queued-input.test.ts`); no host lets the user do it. The ACP
      host queues no input (a second prompt while one runs is refused) and the CLI drops keys while
      a turn runs, so it comes with a host that queues input (labkit-web's).

### The coding agent

- [ ] The CLI does what the ACP host does. Built: `/export` (`markdownOf`); `retryIncomplete`; the
      REPL shows text and thinking as they arrive (`session.streamed`); at a terminal, a new session
      whose model cannot be used opens the REPL without a model, and the session opens once one is
      picked. To do: open its session from a draft at the first input (`src/agent-host/draft.ts`,
      turn zero), so a CLI quit before any input leaves no session.
- [ ] Code mode: the model writes a script that calls the session's tools as functions and composes
      them (map, filter, chain), and the harness runs it as one tool call. Dan's decisions
      (2026-10-03):
      - The runtime is QuickJS compiled to WebAssembly (`@earendil-works/pi-codemode`, which runs
        under Bun: tested), behind an abstraction, so that execution can move to another sandbox
        later; an IPython kernel per session comes after, then a bridge from a local kernel to a
        remote one (a Colab VM).
      - The script is a machine of its own, a child of the call machine, posting messages to its
        parent's inbox; the tool calls it makes are carried out as calls attributed to it.
      - What goes back to the model is an envelope, with nothing the script has to ask for: its
        result (text or JSON), `logs[]` (from a `console.log` shim), its errors, its wall-clock
        time. The logs stream to the host as they come.
      - Headless: a call inside a script that would need permission is refused. Which tools a script
        may call is configured: `permitted` (those that need no permission), `safe`, or a list the
        host or user gives; a call to a tool outside it is refused all the same.
      - The functions a script calls are generated from the tools' schemas, and check their input
        first, failing early with the schema's message.
      - A crash in the middle of a script leaves it indeterminate, its logs as far as they got; it
        is not run again. The model looks at the world through its tools and writes another.
      Prior art, read for this (notes in the session's scratchpad): yolk-sdk, pi-codemode,
      Cloudflare's code mode, Anthropic's programmatic tool calling, smolagents.
- [ ] The system prompt belongs in context assembly, as configuration; it is to be designed and
      tried. A hard-coded one ("You are a helpful assistant") will do until the host's question
      of where a user's things live has an answer.
- [ ] `list_dir` in a git repository says what git knows of each entry: ignored
      (`Repository.isPathIgnored`) or its status (`Repository.findStatusFile`, which includes
      ignored) (Dan, 2026-10-06).
- [ ] A current folder inside the working folder, so that a session works in one package of a
      monorepo (Dan, 2026-10-06). The git tools then do what `git` does from that folder: they find
      the repository above it. Where a path may go (inside the workspace, through a symbolic link)
      is a policy of the workspace or editor wrapper, not of each tool.
- [ ] `/allow env:NAME` passes one environment variable that the command environment removes (a
      credential such as `GITHUB_PAT`) through to the session's commands; its completion offers the
      variables set in the shell, so the user checks the shell's set-up where it matters.
      `/allow net:github.com` allows requests to a host, once network access is modelled; it is not
      (Dan, 2026-10-06).
- [ ] `/preview` (or `/system`): the CLI shows what the next model request would send, the system
      prompt included. `/tools` shows the tools; nothing in the CLI shows the system prompt (Dan,
      2026-10-06).
- [ ] Tools as primitives and wrappers, and an execution context that both hosts use: Dan's
      direction and its order of work are in `docs/agent-tools-direction.md`. Its steps 1 to 3 are
      built; replacing a tool by name, the built-in tools as a bundled plug-in, and the execution
      context as a module of its own are not ordered yet.

### Compaction

The proof of concept is shown. Before a session is run up to a compaction as a daily driver, it has
to be pleasant to live with; this list is expected to grow.

Built: the window marker, naming what decided it (`docs/agent-machine.md`); compaction for the provider
being asked, summaries per provider kept in memory or as files, policies asked between turns, and
the view that sends each provider its own summaries (`docs/agent-context.md`); a provider's own
compaction as a summary, for OpenAI and xAI (`openai-compaction.ts`, `xai-compaction.ts`,
`provider-compaction.ts`), sent the session's system prompt and tools; a digest of a span made
with no model, its attachments as pointers and one line for each tool call (`digest.ts`).

- [ ] When to compact, as a setting (Dan, 2026-10-06), the first use of configuration scoped to a
      model or a provider (`docs/agent-config-direction.md`): a global `autocompact` threshold, as a share
      of the context window or as a number of tokens (`"60%"`, `"192k"`), that a configuration can
      override for one model or for one provider, with models.dev's data as the defaults. A model
      that loses accuracy late in a 1M window can compact at 60%; a provider that charges more above
      a context size can compact below it; a small model (Claude Haiku 4.5, grok-build-0.1) can
      keep enough context to write up what it found, at `"75%"` or `"192k"`.
- [ ] The loop asks the compaction policy itself; today whoever runs the session asks it between
      turns.
- [ ] An estimate of the next request's size (estimated context usage), for a policy that
      compacts automatically at X% of the current model's context window. It is the sum of:
      - the conversation so far: the input and output tokens the last response reported (exact,
        for what that request carried and what came back), plus an estimate for the facts
        recorded since;
      - what the user has typed in the composer;
      - files and other context attached to it;
      - the tools, and the tool calls and results the next turn may bring;
      - room for writing a compaction summary.
- [ ] Anthropic's own compaction (the compaction block, beta `compact-2026-09-04`).
- [ ] A summarizer that asks a model to write a text summary with our own prompt.

### Sessions

- [ ] Where a host keeps what it writes (Dan, 2026-10-06): `~/.local/share/<brand>/`. Built:
      every host's sessions in `sessions/v0.1.0/` (a change to their shape moves them to the next
      version's folder, so no session store has to read an older shape), each with a record that
      names the host that made it; the log files in `logs/`. To do: large tool outputs spooled to
      disk, blobs (images, audio, other binary content), and a human-readable formatting of the logs
      beside the JSONL. Continuing a session in another host than the one that made it waits for a
      session's tools to change during it.
- [ ] Provider usage (Dan, 2026-10-06). What is built is in `src/instrumentation/README.md`. To do:
      a summarizer's requests are not in the facts, so their tokens and cost are in no session's
      totals; on a failed request after a fallback, the request's span names the model it asked,
      because `ModelFailed` does not record which fallback failed last (the attempt spans do); tokens
      and cost attributed to each tool call (omp splits a turn's evenly across its calls) need the
      tool span to name the request that asked for it.
- [ ] Each model request's HTTP bodies (Dan, 2026-10-06, 2026-10-07). Built: captured as files and
      linked to the attempt's span (`src/instrumentation/README.md`). To do:
      - a retention rule for capture files: none is decided; the logs folder's size is shown and
        alerted on at 1 GB, and only while `bun run observability:captures` runs;
      - the adapters' changes to each request (parts omitted, settings not translated, thinking
        disabled for a forced tool call, `strict` and `tool_choice`) recorded as facts, not only in
        the log and the captured body (Dan, 2026-10-07: a branch of its own);
      - the CLI's `-p` runs log to stderr, with their capture lines; whether they also write
        `cli-<session>.log`;
      - a session's logs layer is provided twice (`withCliSession` and `withSession` each provide
        it), so a warning logged while the layer is built (`host_logs.secrets_not_looked_for`)
        appears twice in the CLI's log;
      - lgtm resets its datasources when its container is rebuilt: `bun run
        observability:datasources` is run by hand after `lgtm-stack.sh`;
      - captures from zork's two sessions are checked by reading the code, not by a live game.

- [ ] Additional directories (Claude Code's `/add-dir`, ACP's additional directories): folders a
      session may use at the same trust level as its working folder. Claude Code asks whether the
      directory is added for this session or remembered (Dan, 2026-10-07).
- [ ] A session is not bound to its working folder for ever (Dan, 2026-10-07): moving it to another
      folder forks it and rewrites its turn zero, which records the working folder. Waits for forks,
      below.
- [ ] Forks as sessions, and the turn pointer (`session/turn`; turn zero of a root points at
      itself). A fact is addressed by its session and its position. In the CLI,
      `--fork-session` (commented out): go on from an earlier turn of a session, as a new one, to
      walk back past a turn a refusal followed. The ACP host's `session/fork` waits for it and does
      not advertise `fork`: copying a session's facts as they are keeps fact 1, `SessionOpened {
      session }`, naming the source, and the loop reads its session from there (its log
      annotations, the session's span, each request's `Work`), as do the `/export` header and
      compaction's summaries (`agent-context/compaction.ts`), so a fork would act as its source.
      What the host needs of the core: given a session's facts, a new `SessionId` and optionally a
      position (whole turns up to it), the facts a new session begins with, its opening naming the
      new session; the host appends them to a new store. Whether window summaries and blobs follow
      a fork is the core's to say. A write-up of the problem, from the Claude Code session that
      untangled forked sessions: https://claude.ai/artifact/2BK693wUdiGbTGcJJyCB4Y

### Providers

- [ ] One limit on each provider for every session a runtime holds, at the HTTP client the provider
      adapters share, so that agents run side by side do not use up a provider's rate limits (omp
      does this). Effect has it: `HttpClient.withRateLimiter` over `persistence/RateLimiter` (keyed,
      per provider or per provider and key; fixed window or token bucket; it reads the provider's
      rate-limit headers and waits out a 429; in memory, or in Redis across processes; marked
      unstable in 4.0.0), and `Semaphore` or `PartitionedSemaphore` for how many requests are in
      flight at once. Its `times` (retries after a 429) defaults to no limit, and it waits until the
      reset the provider says: set `times: 0`, so that it only paces requests and our retries
      (`withRetries`, with `longestWait`) decide what a 429 becomes. Beside it, a breaker on each
      provider: after repeated failures, no request for a while, rather than each session finding
      out for itself.
- [ ] A provider's usage window (a subscription's limit, which resets in hours) as a policy of
      its own, once there is a configuration story: today a rate limit whose wait is longer than
      `Retries.longestWait` (1 minute) fails the request at once, with the wait it said.
- [ ] A model request policy that waits, woken when it may go on (the usage window above, a pause
      on a provider, `notBefore` in `src/examples/policies.ts`). Dan: fail it for now, telling the
      user to wait; waking it needs background jobs and watchdogs, a more stateful runtime.

- [ ] Effect's `Response.Usage` shape for a response's token counts, in place of our own.
- [ ] Each provider's image and file formats, from what was measured, in place of models.dev's
      "takes images: yes or no".
- [ ] The Chat Completions adapter against the local server (Rapid-MLX, vLLM-compatible, at
      `http://localhost:8000/v1`; OpenAPI docs at `/docs`), and what the back-ends' documentation
      and source say a client must do. Built:
      - the reasoning effort, as `reasoning_effort` (Qwen3.5-9B takes `none` to `xhigh` and
        refuses `max`); the output limit, as `max_tokens`, when one is set;
      - tool calls, both ways (Qwen called `read_file` and `write_file` through the CLI);
      - streaming: a tool call passed on once the next begins; a server that answers whole is
        read as one chunk;
      - what a response held besides its text and calls goes back to the provider and model that
        produced it, as it came: the message's other fields (`reasoning_content`, `reasoning`,
        ...), a call's (Gemini's `extra_content`), and the chunks of a `content` that is a list
        (Mistral's thinking, which changes shape during a stream); another model's thinking goes
        as text, as opencode and pi-mono send it;
      - a call's `arguments` sent as a JSON object are read as its text; a call's name sent whole
        again as it grows (llama.cpp) is the whole name;
      - `finish_reason` `end_turn` (xAI) and `model_length` (Mistral) are classified; `error`
        (Mistral, OpenRouter) and Groq's `x_groq.error` fail the request;
      - the usage, where each back-end puts it (`usage`, Groq's `x_groq.usage`, SGLang's
        top-level `reasoning_tokens`).

      To do:
      - Mistral: a way for a host to leave out `stream_options`, when one sends to Mistral. Its
        schema refuses fields it does not define (read from the schema; not seen).
      - OpenAI, when a host sends its Chat Completions there: the output limit as
        `max_completion_tokens` (it refuses `max_tokens` for its o-series models).
- [ ] An end for each attempt of a model request on `streamed`. A fallback (`model-fallback.ts`)
      makes several attempts in one request, which has one `ModelResponseEnded`, and `passingOn`'s
      throttle holds an attempt's last deltas until the next attempt's first item. An attempt that
      fails after it streamed text leaves that text on a client's screen, which cannot take it back,
      and the next attempt's text is sent after it. The host counts both as sent, so `ModelResponded`
      sends nothing more, and names both by the request's first dispatch (`messageId`), so a client
      joins them into one message, while `session/load` replays the fallback's text alone. (An
      attempt that fails before it streams, such as on a 503 or a 429, gives the same text and ids
      live and on load.) Fix: the fallback chain passes on an end for the attempt before it tries
      the next target (a `Streamed` item through `ModelStream`, published as a captured item such as
      `ModelAttemptEnded`), and `passingOn` releases what it holds there. The projection then starts
      the request's response again: what the failed attempt sent is not counted against the next
      attempt's parts, and the next attempt's messages are named by its own dispatch.
- [ ] A tool call without an id from the Anthropic adapter (`tool_use` without `id`) or the
      Responses and xAI adapters (`function_call` without `call_id`) is `Unrecognised`: it does not
      run, and nothing is logged. Their APIs always send the id; give one as the Chat Completions
      adapter does (`IdGenerator`, a warning) if a server that omits it turns up.
- [ ] Models. Built: the well-known models as generated `const` data (`bun run models:refresh`:
      models.dev's catalog merged with `well-known-models.measured.json`); a settings type per
      well-known model (`SettingsFor`); the values to offer for each setting of a model as it is
      set now, which are the ones its provider's adapter applies as asked (`choicesFor`); a model
      that is not well-known is asked with what models.dev's catalog says of it
      (`catalog-models.gen.ts`); what is known of a model travels on each request's target, from
      `KnownModels`, whose sources a host can put in front (the CLI gives a `localhost` model what
      its server lists); the CLI's `/settings` picks among the choices, and its prompt completes
      commands, models and settings with Tab.
      To do: when a setting is changed, `/settings` says what this provider does with the value
      (OpenAI caches for minutes whatever is asked; xAI has no cache setting), so the user knows
      before a request is sent; measure the efforts of Anthropic's models.

## Later: worth doing, not core

- [ ] Docs (Dan, 2026-10-07): the design docs move to `docs/dev/`, in one mechanical commit with
      the references to them in code comments; the guide (`docs/guide/`) grows as features settle.
- [ ] `native/bash-segments` as a package of its own, as `effective-acp` is (Dan has ideas to build
      on it: agents' intent, side effects, whether a command is safe to replay or retry).
- [ ] `/retry` after a failed turn (Dan, 2026-10-05: not needed yet). A tool call that arrives
      while a response streams runs at once. When the model request then fails (`ModelFailed`,
      after retries and fallbacks), the turn ends `Failed`, the response is not recorded, and no
      later request sends the model the call or its result. The tool ran and may have changed
      things, and the model does not know, so it may repeat the action. The turn ends once the
      calls still running when the request failed have ended. `/retry` would start a new turn
      whose first request carries the failed turn's calls (`ToolCallArrived`) and their results.
      The facts already hold the calls, their dispatch and their ends; text that streamed before
      the failure is not recorded.
- [ ] Secrets in data the host does not hold (Dan, 2026-10-04): a provider's error body, an MCP
      server's stderr, a command's or a tool's output. Built: every log leaves out the values of
      the environment's credentials and of credential fields (`agent-host/redaction.ts`). To do: secrets that
      are not the environment's values (keys and tokens found by their patterns, as a secret
      scanner finds them); the session's facts and what the model is sent, which are not redacted;
      credentials' values under 8 characters, which the logs do not look for; and which variable
      names hold credentials (`isCredentialName` in `agent-process/environment.ts`). A name's words are separated by `_`, `-`, `.`
      and camel-case transitions, so these names hold no credential word: an all-lower-case name
      that joins words (`githubtoken`, `dbpassword`, `myapikey`), and a name whose credential word
      follows a capital with no separator (`PGPASSWORD`), or is not one of the words (`MYSQL_PWD`).
- [ ] Credentials in the editor's terminals: a command that runs in the editor's terminal (ACP
      `terminal/create`, which `run_command` uses in the editor's world) receives the editor's
      environment, credentials included. ACP lets an agent add variables to a terminal's
      environment, but not remove them.

- [ ] Caching, tuned with compaction. Built: the `cache` setting (off, 5m, 1h); Anthropic reads
      nearly every request from the cache with it (FizzBuzz, 20 turns: 27,556 of 29,032 input
      tokens). To do: OpenAI reported 0 cached tokens in every FizzBuzz run; the runs' input token counts
      were not looked at, so whether caching was to be expected is not known, and they come first;
      and compaction that knows the provider's cache: from the time since the
      provider's last summary (`writtenAt`) and its cache's lifetime, whether the next request can
      still read the cache, and so whether keeping its beginning unchanged saves anything.
- [ ] `prompt_cache_key` (OpenAI, xAI) for cache-aware work.
- [ ] Changes to the system prompt or tools after the session opens, as facts of their own: the
      counterparts of `ImmutableSystemPrompt` and `ImmutableToolCatalog` (the readers
      `immutableSystemPromptOf`, `immutableToolCatalogOf`), which read only the opening now. Zork's
      adventurer is offered a different part of its catalog in each request; only each request's
      recorded context shows which.
      Anthropic takes tool changes mid-conversation as `tool_addition` and `tool_removal` blocks;
      Codex records settings changes as `thread_settings_applied`.
- [ ] Returning to the first provider after a fallback by itself; today it is the user's to switch.
- [ ] OpenAI `async: true` on a tool: the model goes on past a call before its output is returned.
- [ ] OpenAI mid-turn steering (GPT-6, over a WebSocket to the Responses API): new input during a
      response. The core delivers input at a step's boundary; this would deliver it sooner.
- [ ] OpenAI `end_turn` on a completed response. Codex follows a response with another request when
      it is `false` (`codex-rs/core/src/session/turn.rs`); the responses the public API returned to
      this harness carry no such field. It would map to `Unfinished`.
- [ ] A response that reads as unfinished with no mark from the provider (oh-my-pi's "unexpected
      stop": nothing visible, or text a small model judges to have stopped partway).

## Try

- [ ] FizzBuzz runs written out as trajectories, as sample data for the UI.

## Trajectories

Run both sweeps after a change to a core machine (`bun scripts/trajectories/sweep.ts codex`, then
`claude-code`), and read the counts of sessions with observations not expected or undelivered. On
2026-10-07: Codex 0 of 180 files; Claude Code 3 of 805.

- [ ] Claude Code: the 3 sessions. On 2026-09-30 such observations were errors Claude Code reported
      after a response the core had already taken as the step's outcome (after a refusal, or an
      answer); read the 3 again to say what each is.
- [ ] Codex: three responses in files from 2026-08 are split in two by a `token_count` that arrived
      mid-response, and the first half is recorded as `Unfinished`.
- [ ] Codex: 8 turns still running when Codex completes them; 10 completions while another turn
      runs. Neither diverges.
- [ ] Codex compactions copy the user's messages word for word; match them back to positions so
      `kept` means the same for both tools.
- [ ] The request that writes a compaction's summary has no place: Claude Code does not record it,
      and the Codex importer counts and drops it.
- [ ] Claude Code starts tools while a response streams; the importer gives such results after the
      message and does not record the early start (`ToolCallArrived`).
- [ ] Codex: every tool result is recorded as `Succeeded` (`scripts/trajectories/codex.ts`). Failures
      are in the files: `exec_command_end.exit_code`, `patch_apply_end.success`, the exit-code
      header of a tool's output, and `success`. agents-bridge's Codex normalizer reads them
      (github.com/jagenaujagenau/agents-bridge, `CodexNormalizer.ts:165-183, 425-513` at
      `5ce9a787`; it has no license, so its format knowledge is ours to read, not its code to copy).
- [ ] Claude Code: subagents' sessions are skipped (`claude-code.ts` drops every `isSidechain`
      record). They are files of their own: `<parent>/subagents/[workflows/<wf>/]agent-<id>.jsonl`, or
      a flat `agent-<id>.jsonl`, with a `.meta.json` beside it naming the `agentType`; Codex's
      children name their parent in `session_meta.source.subagent.thread_spawn` (agents-bridge,
      `ClaudeCodeAdapter.ts:66-92`, `CodexAdapter.ts:103-117`). Import them as sessions of their own,
      linked to the parent's call that started them.
- [ ] Not mapped yet: messages between agents (for moderated debates and peer review later),
      images, `fork-context-ref`, `model_refusal_no_fallback`, developer messages (system prompts).

## Parked by Dan

- Saying before sending that a request to compact will not fit the summarizer's context window: it
  needs the estimate of the next request's size, whose room to reserve is parked below.
- How much room to reserve in the estimate of the next request's size: not until the usage
  figures are shown to be reliable, which needs the agent in daily use for coding.
- Running `models:refresh` on a schedule: it is run by hand when a provider releases models.
- A hook that retries a refused request with another model: a downgrade after a refusal mostly
  ends with the conversation abandoned. Not worth automating yet.
- Google (no Effect package).
- Jev, later, as a tool.
- Attachments and system records in Claude Code sessions, including exo's injected memories.
