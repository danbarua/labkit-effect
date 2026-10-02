# To do

What is to be built, by capability. What is built is in each module's `MODEL.md`; direction that is
not yet work is in its `DESIGN.next.md`. Delete an item when it is done or dropped. As of
2026-10-02.

## Build

### The hosts: ACP and the CLI

Both hosts are built here, and labkit imports the libraries from here. The core is the mediator
between a host and the models (machines, messages, streams of events): the workspace, the working
folder, the tool catalog, the configuration UI and what a session is called are the host's.

ACP: the protocol is built (`src/acp`: schemas, the peer, stdio and Streamable HTTP, negotiation;
its `MODEL.md`, and `EFFECT-FIT.md` for where Effect fits). The host, which joins it to the
session, is not. VS Code comes first, then the JetBrains AI extension (PyCharm, WebStorm). The
protocol versions and features are those of the labkit monorepo's ACP host, for parity; what
`session/load` sends back is the ACP side's to decide. In ACP, tools go through the editor.

A real ACP session's log
(`~/.labkit/logs/acp-44517-ec9d22b3-8c0d-465a-83c7-9c227e0aec77.jsonl`, labkit-agent, local Qwen)
is the set of capabilities a first working host needs: choose a model and a thinking level, send
the first input, stream thinking, the model calls a tool, the user is asked for permission, the
tool runs, the model answers, and `/export` writes the session to Markdown without going to the
model.

- [ ] Configuration comes from the host, and is assembled before a request is made; a change
      applies between turn N and turn N + 1. A new session is configuring until it is ready to
      start turn zero: a UI with no default model, thinking level or output limit has nothing to
      launch, and its submit is not enabled until it has (the same machines can run in the UI).
      In the log: the providers on offer are a model catalog (models.dev) filtered by which
      credentials are set, plus a local server; the user changes the model, thinking and output
      limit with ACP's `session/set_config_option`. Here: the opening is the configuration, a
      change is `ModelChangeArrived` from `User { via: acp }`, taken between turns (M1–M3); the
      log's configuration versions are our host's numbering (labkit-agent), ours to change, as
      `Seq` is the session's.
- [ ] Tool permission. Built: each tool call goes through `ToolCallPolicy` in the loop; the
      permission modes (`default`, `acceptEdits`, `dontAsk`, `bypassPermissions`) by each tool's
      kind; what is asked and answered recorded (`PermissionAsked`, `PermissionAnswered`); allow
      for the session read from the facts; the CLI's `--permission-mode` and its REPL question. To
      do: the ACP host's `session/request_permission`; `plan` and `auto`; allow and deny rules by
      tool and argument; resetting permissions.
- [ ] Accounting for ACP. Built: a provider-neutral `usage` on each response; `contextGauge` (used,
      size, cost) and `requestsIn` (a turn's model requests) read from the facts (`accounting.ts`);
      prices with the well-known models; `maxTurnRequests` as an example host policy. To do in the host: send
      `usage_update` after `session/new` or `session/load`, after a prompt, and when the numbers
      change; answer a vetoed request with `max_turn_requests`, a cut-short response with
      `max_tokens`; refuse the next prompt with an error at a session-level turn limit (ACP has no
      stop reason for it). Open: after a compaction `used` is the last response's until the next one
      reports (an estimate would come from the next-request size estimate); a summarizer's own
      requests are not counted in `cost`. `PromptResponse.usage` is a draft; not built.
- [ ] Attachments. Built: input carries files by reference (`InputArrived.attachments`); a tool's
      output that arrives as bytes is kept in the blob store and recorded by reference (`Received`
      body `Stored`); bytes in the blob store (`Blobs`: in memory by default, or a folder); each
      adapter sends images and PDFs as its provider takes them, in a user message or a tool result,
      a text file as its text, and anything a model is not known to take as a pointer, logged;
      counting a request's input before it is sent (`anthropic-count.ts`, `openai-count.ts`; xAI has
      no endpoint). Live: all three read an attached image and PDF, and an image a tool returned;
      the counts before sending matched what the responses reported. Left: the host's intake of ACP
      prompt content as typed parts; the client half (sending, drawing, resolving `blob://`),
      labkit-web's.
- [ ] Slash commands the host handles itself (`/export`), which are not input to the model.
- [ ] `session/new`: a session opened with its store and its opening.
- [ ] `session/update`: what the session's facts and what its requests stream (`streamed`) become
      for the client: text and thinking as they arrive, tool calls and how they end, the plan.
- [ ] `session/cancel`: the turn interrupted (`TurnInterrupted`; agent-machine X1 ends it).
- [ ] The editor's files and terminal as tools (`fs/*`, `terminal/*`, when the client offers
      them). A terminal is a tool whose call carries the terminal's id (`effect/ai/IdGenerator`
      gives ids).
- [ ] The MCP servers a client names in `session/new`, their tools offered to the model. Effect has
      MCP's schemas, protocol and a server (`effect/ai/McpSchema`, `McpProtocol`, `McpServer`) and
      no client: a client built from them, as `src/acp` was built.

### The coding agent

- [ ] Tools for coding, in the CLI's own: an edit that changes part of a file, a shell (tests,
      git), search (grep, glob). The CLI has `read_file`, `list_dir` and `write_file`.
- [ ] The REPL shows text and thinking as they arrive (`session.streamed`), not the answer when
      the turn ends.
- [ ] The system prompt belongs in context assembly, as configuration; it is to be designed and
      tried. A hard-coded one ("You are a helpful assistant") will do until the host's question
      of where a user's things live has an answer.

### Compaction

The proof of concept is shown. Before a session is run up to a compaction as a daily driver, it has
to be pleasant to live with; this list is expected to grow.

Built: the window marker, naming what decided it (agent-machine S4); compaction for the provider
being asked, summaries per provider kept in memory or as files, policies asked between turns, and
the view that sends each provider its own summaries (agent-context A5–A8); a provider's own
compaction as a summary, for OpenAI and xAI (`openai-compaction.ts`, `xai-compaction.ts`,
`provider-compaction.ts`), sent the session's system prompt and tools; a digest of a span made
with no model, its attachments as pointers and one line for each tool call (`digest.ts`).

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

- [ ] The session store. Built: `SessionStore`, which the loop requires (`EphemeralSessionStore`,
      `FileBackedSessionStore`); each fact written before anything is done on it; a failed write
      stops the session; a turn left running goes on (`goOn`: a model request made again, only
      `safe` tool calls run) or ends, as the host chooses (the REPL asks; `-p` goes on); Ctrl+C records
      the turn as interrupted. To do: a store for ACP hosts (`session/load`).
- [ ] Forks as sessions, and the turn pointer (`session/turn`; turn zero of a root points at
      itself). A fact is addressed by its session and its position. In the CLI,
      `--fork-session` (commented out): go on from an earlier turn of a session, as a new one, to
      walk back past a turn a refusal followed.

### Providers

- [ ] Effect's `Response.Usage` shape for a response's token counts, in place of our own.
- [ ] Each provider's image and file formats, from what was measured, in place of models.dev's
      "takes images: yes or no".
- [ ] The Chat Completions adapter against the local server (Rapid-MLX, vLLM-compatible, at
      `http://localhost:8000/v1`; OpenAPI docs at `/docs`). Built: the reasoning effort is sent as
      `reasoning_effort` (Qwen3.5-9B takes `none` to `xhigh` and refuses `max`); tool calls, both
      ways (Qwen called `read_file` and `write_file` through the CLI). To do, for parity with
      core-agent and for small tasks on the local model: streaming; `reasoning_content` sent back
      (it is left out of every request now, and logged once for each model); an output limit; the
      other settings.
- [ ] Models. Built: the well-known models as generated `const` data (`bun run models:refresh`:
      models.dev's catalog merged with `well-known-models.measured.json`); a settings type per
      well-known model (`SettingsFor`); the values to offer for each setting of a model as it is
      set now, which are the ones its provider's adapter applies as asked (`choicesFor`); what is
      known of a model travels on each request's target, from `KnownModels`, which a host can
      provide (the CLI gives a `localhost` model what its server lists); the CLI's `/settings`
      picks among the choices, and its prompt completes commands, models and settings with Tab.
      To do: when a setting is changed, `/settings` says what this provider does with the value
      (OpenAI caches for minutes whatever is asked; xAI has no cache setting), so the user knows
      before a request is sent; measure the efforts of Anthropic's models.

## Later: worth doing, not core

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
      `immutableSystemPromptOf`, `immutableToolCatalogOf`), which read only the opening now.
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

Run both sweeps after a change to a core machine, and read the counts of sessions with
observations not expected or undelivered. On 2026-10-02: Codex 0 of 171 files; Claude Code 3 of
783.

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
- [ ] Not mapped yet: subagents and messages between agents (for moderated debates and peer review
      later), images, `fork-context-ref`, `model_refusal_no_fallback`, developer messages (system
      prompts).

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
