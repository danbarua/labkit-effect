# agent-context: direction

Dan's direction for context assembly and compaction (2026-09-29). Nothing in this document is
built. What is built is described in [agent-context.md](agent-context.md); the work planned next is
in `TODO.md`.

## Views of a session

- **The journal.** Every fact recorded, append-only. Some systems call it the trajectory. A person
  reading the session reads the journal from head to tail.
- **The model's view.** A projection of the journal. After compaction, it is a chain of summaries
  followed by the recent facts. Each summary or substitution records pointers to the journal
  entries it replaces, and the model can call a tool to look up the full journal.
- **Usage.** Two views over the same recorded usage:
  - spend: what the model was sent, for decisions during the session;
  - exposure: what any model has seen over the whole session, for reports.

## Compaction that knows the provider's cache

When the provider's cache has expired, the next request costs the same whatever it contains. That
is the moment to compact, if the context's size justifies it. Each response's usage, including
cache reads and writes, is already recorded in its `metadata`.

Candidate substitutions, each recording pointers back to the entries it replaces:

- prune stale context;
- summarise or drop tool results;
- replace a run of failed tool calls with the lesson learned from it;
- replace a merged pull request's discussion, reviews, notifications and CI runs with its body;
- replace many such events with a digest ("this week in project X").

## Work the harness can do before the model asks

After the first steps of a task (grounding, reconnaissance), the next read-only actions are often
predictable: `git status`, the latest test results, the tail of a log. The harness can run
effects that have no side effects ahead of time and put their results into the next step's
context, so that no model request is spent asking for them. A lighter form is a per-step tool
catalog with pre-filled "hint" calls that the model might make next. Both need to know which tools
are read-only, as a property of the tool.

Further ideas of the same kind. Each needs the model's commentary and thinking beside each tool
call:

- The opening's tool catalog holds only the tools that are always available. The other tools are
  offered per step, chosen from the state of the workspace, with the likely next actions as a
  menu. This reverses the "ask the user" tool: the harness tells the model what changed and what
  it can do next.
- A small, fast model reads what the model wrote before a tool call, together with the call, and
  the harness proceeds, vetoes or advises. This replaces an `intent` argument on every tool.
- The project's own scripts become tools in place of a shell tool (`bun pm pkg get scripts` gives
  their schema).
- An edit made outside the edit tools (a here-document, a regex over many files) is allowed, and
  its diff is recorded. When the edit changed a large number of files, the harness rolls it back
  and tells the model.
- When a change affects every session working in the repository (a dependency added to
  `package.json`), the harness detects it and sends it to all of those sessions as a notice.

## Identity: sessions, turns and forks

A session has an id, and so does a turn. A turn's parent is a pointer to a session and a turn:

- Turn zero of a root session points at itself (`session/session`). A pointer to itself marks the
  root.
- Turn zero of a fork points at the session and turn it was forked from
  (`parent-session/parent-turn`).

On disk the pointer is one field; a database may split it into two columns for joins. A fork reads
its parent's history through the pointer, so forking copies nothing, unless the fork is made with
a copy of the parent's history. A fork can rewrite a copied history independently of its parent and
of its siblings.

### How Claude Code and Codex record compaction (their session files, 2026-09-29)

- **Claude Code** records a compaction inside the session's journal, under the same session id: a
  `compact_boundary` record, the recent messages that it keeps verbatim, the token counts before
  and after, and the summary as a message marked `isCompactSummary`. It does not record the model
  request that wrote the summary.
- **Codex** records a `compacted` record in the session's journal. The record carries the whole
  history that the model sees from then on, and chains windows (`window_id`,
  `previous_window_id`). Codex records the request that wrote the summary inside the turn, as a
  response marked as the final answer. A subagent is a new session with `forked_from_id`: the field
  names the parent session but not the point it forked at, and the subagent starts with a copy of
  the parent's history.

Both write the summary into the append-only journal, where it stays whatever its quality.

## Compaction with forks

A journal with cheap forks allows more than a journal that holds everything. One log that holds
everything is like one process that holds everything; cheap forks are like Unix `fork()`.

- A request to compact is refused before it is made when it would not fit the summarizer's context
  window.
- Cheap forks allow:
  - trying compaction strategies side by side over the same parent (A/B tests);
  - forks that keep different facts: a fork made for a purpose keeps what that purpose needs,
    which is the reason a user forks at all;
  - strategies per provider or per model (cache-aware, attention-aware), or after a switch of
    model;
  - compaction by meaning: fork, drop what the fork's goal does not need, and keep revising the
    compacted history as the goal changes. A compacted fork of a fork can diverge from its
    parent's compacted fork.
- Compacting between steps is one strategy, like stop-the-world garbage collection. A request to
  compact goes to the inbox like any other message, and waits for a point between steps. That does
  not rule out summarising asynchronously, or ahead of time, beside it.
- **Summarising ahead of time.** A worker beside the session follows it and rolls tool calls up as
  they happen: a file read becomes "read file foo.ts", a write "wrote file foo.ts", a pull request
  "GH: owner/repo/pulls/123". The worker runs off-line, before compaction is needed, and shrinks
  what a model is later asked to summarise. The same summaries serve an advisor agent,
  evaluations and analytics.
- **Compactions that a provider decides.** Anthropic returns a compaction block (beta
  `compact-2026-09-04`) when it decides to compact; the window is observed in its response rather
  than requested. It is one more provider's summaries: a session that goes to another provider
  afterwards is compacted for that provider from the beginning, or ahead of time.
- **Side-by-side display.** Summaries point at the windows they cover, so a history can show two
  or more providers' compactions of the same span side by side, and our own strategies can be
  evaluated against them the same way.

## Forks copy nothing

Facts are never rewritten, and summaries are not facts. A fork is therefore a pointer (the parent
session and a position) plus the facts that the fork appends itself. Reading a fork reads the
parent's facts up to the fork point, then the fork's own. The parent is append-only, so it can grow
without changing its forks. This holds because:

- a fork point is a position where the machines' state can be rebuilt by folding the facts before
  it: between steps at the least, and ideally between turns;
- the parent is never truncated or edited;
- a fact is addressed by its session and its position there. A position alone is not enough,
  because a fork and its parent each number the facts after the fork point.

## Behaviour as extensions

Compaction strategies, like all other behaviour, are extensions hooked into the core's machines.
The Effect layer orchestrates: it schedules effects, routes messages and observations, and applies
policies. A harness that behaves like Codex, or like Claude Code, would each be a bundle of
policies.
