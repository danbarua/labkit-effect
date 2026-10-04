# To do

What is to be built, by capability. What is built is in each module's `MODEL.md`; direction that is
not yet work is in its `DESIGN.next.md`. Delete an item when it is done or dropped. As of
2026-10-02.

## Build

### The hosts: ACP and the CLI

Both hosts are built here, and labkit imports the libraries from here. The core is the mediator
between a host and the models (machines, messages, streams of events): the workspace, the working
folder, the tool catalog, the configuration UI and what a session is called are the host's.

ACP: the protocol is built, as a package of its own (`effective-acp`,
github.com/danbarua/effective-acp: schemas, the peer, stdio and Streamable HTTP, negotiation; its
`src/MODEL.md`, and `src/EFFECT-FIT.md` for where Effect fits). The host, which joins it to the
session, is built for protocol v1 over stdio (`src/agent-acp`, `bun src/agent-acp/main.ts`; its
`MODEL.md`) and has run the scenario below against the local Qwen with the SDK's client. It has not
yet been seen in an editor. VS Code comes first, then the JetBrains AI extension (PyCharm,
WebStorm). The protocol versions and features are those of the labkit monorepo's ACP host, for
parity; what `session/load` sends back is the ACP side's to decide. In ACP, tools go through the
editor.

The layers, Dan's rulings and the order of work are in `src/agent-host/DESIGN.next.md`.

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
      Built: ACP's config options, and `session/set_config_option` as the change it asks, served by
      the ACP host for a draft and for an open session.
- [ ] Tool permission. Built: each tool call goes through `ToolCallPolicies` in the loop; the
      permission modes (`default`, `acceptEdits`, `dontAsk`, `bypassPermissions`) by each tool's
      kind; what is asked and answered recorded (`PermissionAsked`, `PermissionAnswered`); allow
      for the session read from the facts; the CLI's `--permission-mode` and its REPL question;
      for ACP, the `session/request_permission` request and its answer, where the client's
      cancelled outcome is a refusal (`src/agent-acp/permission.ts`), asked by the host's feed; the
      mode as an ACP option the user changes (`permission_mode`), from the next turn. To do: `plan`
      and `auto`; allow and deny rules by tool and argument; resetting permissions; a change of
      mode recorded in the session's facts (the ACP host keeps it only while the session is open).
      - `run_command` (the CLI's and the ACP host's) runs any shell command, and permission is
        given per tool: "Allow for the rest of the session" on one call allows every command
        after it (`rm`, `git push`, `curl … | sh`), and `bypassPermissions` runs them all
        unasked. Needed: permission by command (allow for the session names the command, or
        its first words, as Claude Code's `Bash(git log:*)` does), deny rules that hold in every
        mode, and a command split at `;`, `&&`, `|` and `$(…)` judged part by part, so that an
        allowed `git log` cannot carry another command. Dan has a bash invocation parser and
        classifier, which builds a tree of what chained invocations intend: the policy starts
        from it, with Jev classifying what it cannot.
- [ ] Accounting for ACP. Built: a provider-neutral `usage` on each response; `contextGauge` (used,
      size, cost) and `requestsIn` (a turn's model requests) read from the facts (`accounting.ts`);
      prices with the well-known models; `maxTurnRequests` as an example host policy; for ACP,
      `usage_update` and a turn's stop reason, where a vetoed request is `max_turn_requests` and a
      cut-short response `max_tokens` (`src/agent-acp/usage.ts`, `stop-reason.ts`), sent and
      answered by the host after a prompt, `session/load` and `resume`. To do in the host: sending
      it when the numbers change; refuse the next prompt with an error at a session-level turn
      limit (ACP has no stop reason for it). Open: after a compaction `used` is the last response's
      until the next one reports (an estimate would come from the next-request size estimate); a
      summarizer's own requests are not counted in `cost`. `PromptResponse.usage` is a draft; not
      built.
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
      mode, the folder sessions are kept in, log lines to a file or to stderr, the ACP launcher's
      log file (JSONL, rotated, secrets redacted; `bun run acp:logs`), and the host's own record of a
      session in its folder (`host.json`, stored and returned as JSON) (its `MODEL.md`). To do: a
      hand-written `models.yml` as one more source of the catalog.
- [ ] `session/update`. Built: the projection of a session's facts and of the core's captured items
      (`ModelDelta`, `ModelPartArrived`, `ModelResponseEnded`), merged in any order, to the client's
      updates, one function for the live view and for `session/load` (`src/agent-acp/projection.ts`),
      which the ACP host's feed sends: text and thinking as they arrive, tool calls and how they
      end; `session/load` sends the projection of the stored facts before its answer, each response
      before the calls it made, as live sent them, and the feed goes on from the state they leave;
      the model's plan (`update_plan`) as a `plan` update. To do: the last plan sent again on
      `session/load`. Open: live with no deltas (a server that answers whole) announces a call
      before its response's text, which is known only when the response ends.
- [ ] The ACP host's sessions across processes. Built: each session's facts in a file
      (`FileBackedSessionStore`, `~/.labkit/sessions`); the host's record of a session (`host.json`:
      the working folder, a title from the first prompt), written at turn zero; `session/load` (the
      stored facts replayed before the answer), `session/resume` (no replay) and `session/list`
      (by working folder, newest first, paged), with `session_info_update`; a turn the facts left
      running is ended, not gone on with; `session/close`. To do: `session/fork` (it waits for the
      core: Forks, under Sessions); `session/delete`; additional directories. Open: the permission
      mode is not in the host's record, so a reopened session starts at the launcher's mode; ACP has
      no update for how a turn ended, so a replay of a turn that ended without an answer
      (interrupted, failed) shows what its finished requests sent and nothing of how it ended.
- [ ] The ACP host in an editor: the launch command, and VS Code's behaviour with what it sends and
      draws (config options as selects, thinking, permission, tool call content). Then JetBrains.
- [ ] MCP servers. Built (`src/agent-mcp`, on `src/agent-process`): the stdio client; each server a
      machine over a session-scoped process group; the ACP host starts the servers a client names,
      offers their tools after the world's under `mcp__<server>`, tells the model of one not
      running, records their states (`McpServerChanged`), and serves `/mcp` and
      `/mcp reconnect <server>`; the CLI starts the servers its configuration names (its files,
      `--mcp-config`), and one marked `required: true` that does not connect keeps the session from
      opening; `/mcp` in the REPL, with completions; the ACP host reading each session's
      configuration, the client's servers over the configuration's by name, a required one that
      does not connect refusing the session. To do: the REPL's completions and hints from a machine
      of the command line's state; MCP
      servers reached at a URL, which are not supported at all today: a client for the Streamable
      HTTP transport (and the deprecated HTTP+SSE one), then the ACP host advertising
      `mcpCapabilities.http` and `.sse`; tools a server offers
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

- [ ] Trusted folders (Dan, 2026-10-04): a project's configuration is not read until its folder is
      trusted. Until then a project's layer may not name extensions or MCP servers (both run code:
      agent-config CF7, CF10); once a folder is trusted, its layers may. A folder's `.env` is the
      folder's too: Bun reads it by itself where the agent runs, and the options' variables
      (agent-host H19: `LABKIT_PERMISSION_MODE`, `LABKIT_SETTING_SOURCES`, `LABKIT_MCP_CONFIG`) can
      loosen permission or start MCP servers; until the folder is trusted they are not to be read
      from it.
- [ ] Turn-end hooks by name, as policies are: a hold recorded from the hook that made it, so
      `retryIncomplete` counts its own holds, not every hook's.
- [ ] The product's name (Dan is thinking of `whitelabel-agent`): the default brand
      (`agent-host/brand.ts`, agent-host H18) is still `labkit`, and with it the meta variable
      (`LABKIT_BRAND`).

- [ ] Plug-ins and `policies.yml`. Dan's decisions (2026-10-03):
      - A plug-in declares a Schema for its settings, with a default for each, and the entries it
        adds to the seams it knows (policies, turn-end hooks, tool sources, information providers);
        the file is decoded against the registry's Schemas: `use` first, against the names
        registered, then the entry with its plug-in's own Schema, refusing properties it does not
        have. A JSON Schema made from the same Schemas is what an editor checks the file with while
        it is typed. An extension is a module the file names, loaded before the entries are
        decoded, registered as a built-in is.
      - One ordered list per seam (`toolCalls:`, `modelRequests:`, ...), each entry `use: <name>`
        and its settings; a plug-in on two seams is listed in each.
      - A setting that is a function is named in the file: the loop breaker's `key` is a name
        (`toolAndInput`) its plug-in maps to the function.
      - The file is read with Effect's YAML (`effect/encoding/Yaml`), not `Bun.YAML`. Effect's
        `Config.schema` drops a property it does not know without a word, so it does not read it.
      - A session's plug-ins and settings are recorded when it opens; the file is what new sessions
        start with. A change is observed (a draft) and taken (admitted) only between turns, when the
        machines have settled: always, a model's change too and the permission mode's too. A user
        who wants it sooner cancels the turn.
      - The name an entry is used by (`use`) says which entry vetoed (`every` reports it, into the
        origin and the log) and which turn-end hook held a turn, so a hook counts its own holds.
      Not decided: where the file is kept.
- [ ] Later (Dan, 2026-10-03): a change that tightens the permission mode taken between the steps
      of a turn, delivered through the inbox as steering is.
- [ ] Parked (Dan, 2026-10-03): permission in headless mode (`-p`), where no one can answer a
      question: allow and deny lists by tool and argument (Claude Code's `--allowedTools`,
      `--disallowedTools`), or a tool that answers permission questions (its
      `--permission-prompt-tool`, an MCP tool). Today such a call is vetoed, the reason saying how
      to let it run (agent-policy P7).
- [ ] Withdrawing input queued for a turn that has not been delivered: the core does it
      (`InputCancelled`, agent-machine `queued-input.test.ts`); no host lets the user do it. The ACP
      host queues no input (a second prompt while one runs is refused) and the CLI drops keys while
      a turn runs, so it comes with a host that queues input (labkit-web's).

### The coding agent

- [ ] The CLI does what the ACP host does. Built: `/export` (`markdownOf`); `retryIncomplete`; the
      REPL shows text and thinking as they arrive (`session.streamed`). To do: open its session from
      a draft at the first input (`src/agent-host/draft.ts`, turn zero), so a CLI quit before any
      input leaves no session.
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
      the turn as interrupted; the ACP host keeps its sessions in files too, and ends that turn
      when it reopens one (`session/load`, `resume`).
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
      makes several attempts in one request, which has one `ModelResponseEnded`. An attempt that
      fails after it streamed text leaves that text on a client's screen, which cannot take it
      back, and the next attempt's text is sent after it; the host counts both as sent, so
      `ModelResponded` sends nothing more. An end item for each attempt, which the host reads as
      "what was streamed so far is not this response's", would let it say so.
- [ ] Models. Built: the well-known models as generated `const` data (`bun run models:refresh`:
      models.dev's catalog merged with `well-known-models.measured.json`); a settings type per
      well-known model (`SettingsFor`); the values to offer for each setting of a model as it is
      set now, which are the ones its provider's adapter applies as asked (`choicesFor`); what is
      known of a model travels on each request's target, from `KnownModels`, whose sources a host
      can put in front (the CLI gives a `localhost` model what its server lists); the CLI's `/settings`
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
