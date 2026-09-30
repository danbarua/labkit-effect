# agent-context

Assembles what the model is sent next. Each kind of content (system prompts, tool catalogs,
notices) comes from an ordered list of providers, and their outputs are appended in order; the
conversation comes from the `Conversation` service; the model is chosen last, by selectors that may
look at the size of what was assembled. Each is a service, supplied by a layer.

## Direction (Dan, 2026-09-29): not a spec

Recorded so the design can grow into it. Nothing below is built, and none of it is a rule yet.

### Views of a session

- The canonical journal (some systems call it the trajectory): every fact recorded, append-only.
  It is what a person reading the session sees, head to tail.
- The model's view: a projection. After compaction it is a chain of summaries followed by a run of
  recent facts. Each summary or substitution records pointers to the canonical entries it
  replaces, and the model can call a tool to look up the full journal.
- Usage has two views over the same recorded usage: what the model was sent (spend, for decisions
  in the moment) and what any model has seen over the whole session (exposure, for reports).

### Compaction that knows the provider's cache

When the provider's cache has expired, the next request costs the same whatever it contains, so
that is the moment to compact, if the context's size justifies it. Candidate substitutions, each
with its pointers back:

- stale context pruned;
- tool results summarised or dropped;
- a run of failed tool calls replaced by the lesson learned from it;
- a merged pull request's body in place of its discussion, reviews, notifications and CI runs;
- a digest ("this week in project X") in place of many such events.

The signal is already recorded: each response's usage, cache reads and writes included, is in
its `metadata`.

### Work the harness can do before the model asks

After the first steps (grounding, reconnaissance), the next read-only actions are often
predictable: `git status`, the latest test results, the tail of a log. Effects without side
effects can be run ahead and their results put into the next step's context, so no model request
is spent asking for them. A lighter form: a per-step tool catalog with pre-filled "hint" calls the
model might make next. This needs to know which tools are read-only, as a property of the tool.

More of the same kind, all of which need the most signal the model gives (its commentary and
thinking beside each tool call):

- The opening's tool catalog is the few tools that are always on; the rest is offered per step,
  chosen from the state of the workspace, with the likely next actions as a menu. It is the "ask
  the user" tool turned round: the harness tells the model what changed and what it can do next.
- A small, fast model reads what the model wrote before a tool call, with the call, and the harness
  proceeds, vetoes or advises. This takes the place of an `intent` argument on every tool.
- A shell tool replaced by the project's own scripts as tools (`bun pm pkg get scripts` gives the
  schema).
- An edit made round the edit tools (a here-document, a regex over many files) is allowed, its diff
  snapshotted; when it changed a large number of files it is rolled back and the model is told.
- A change every session working in the repo needs to know (a dependency added to `package.json`)
  is detected and sent to all of them as a notice.

### Identity: sessions, turns, forks

A session has an id, and so does a turn. A turn's parent is a pointer to a session and a turn:

- turn zero of a root session points at itself (`session/session`): a pointer to itself marks the
  root;
- turn zero of a fork points at the session and turn it was forked from
  (`parent-session/parent-turn`).

On disk this is one field; a database may split it into two columns for joins. A fork reads its
parent's history through the pointer, so forking copies nothing, unless the fork is made with a
copy of the parent's history. A copied history can then be rewritten in the fork, independently of
the parent and of the fork's siblings.

What Claude Code and Codex do (their session files, 2026-09-29):

- Claude Code records a compaction inside the session's journal, under the same session id: a
  `compact_boundary` record, the recent messages it keeps verbatim, token counts before and after,
  and the summary as a message marked `isCompactSummary`. The model request that wrote the summary
  is not recorded.
- Codex records a `compacted` record in the session's journal, carrying the whole history the model
  sees from then on, and chains windows (`window_id`, `previous_window_id`). The request that wrote
  the summary is recorded inside the turn, as a response marked as the final answer. A subagent is a
  new session with `forked_from_id`: it names the parent session but not the point it forked at,
  and starts with a copy of the parent's history.

### Compaction

Both systems write the summary into the append-only journal, where it stays whatever its quality.
A journal with cheap forks allows more: one log that holds everything is like one process holding
everything, and cheap forks are like Unix `fork()`.

- The journal records the boundary: which span of the session was compacted. The summary belongs to
  a fork whose history is the summary and what follows it, and can be revised, replaced or compared
  without changing the parent.
- A session's compacted forks form a linked list of episodic summaries, each pointing at the one
  before.
- What that allows:
  - trying compaction strategies side by side over the same parent (A/B tests);
  - forks that keep different facts: a fork made for a purpose keeps what that purpose needs (the
    reason a user forks at all);
  - strategies per provider or model (cache-aware, attention-aware), or after switching model;
  - compaction by meaning: fork, drop what the fork's goal does not need, and keep revising the
    compacted history as the goal changes. A compacted fork of a fork can diverge from its
    parent's compacted fork.
- Compacting between steps is one strategy, like stop-the-world garbage collection. A request to
  compact goes to the inbox like any other message, and waits for a point between steps. That does
  not rule out summarising asynchronously or ahead of time beside it.
- Summarising ahead of time: a worker beside the session follows it and rolls tool calls up as they
  happen: a raw file read becomes "read file foo.ts", a write "wrote file foo.ts", a pull request
  "GH: owner/repo/pulls/123". This runs off-line, before compaction is needed, and shrinks what a
  model is later asked to summarise. The same summaries serve an advisor agent, evaluations and
  analytics.
- Providers compact too: Anthropic returns a compaction block (beta `compact-2026-09-04`), OpenAI
  an encrypted `compaction` item. Each is opaque and works only with its own provider, so a
  fallback to another provider after one needs a compaction of its own. That is one more fork over
  the same window: a fallback compaction, made when the chain switches, or ahead of time.
- Compaction forks link back to the journal they summarise, so a history can be shown with two or
  more providers' compactions of the same span side by side, and our own strategies can be tried
  and evaluated against them the same way.

### Forks copy nothing

Facts are never rewritten and summaries are not facts, so a fork is a pointer (parent session,
position) and the facts it appends itself. Reading a fork reads the parent's facts up to the fork
point, then its own. The parent is append-only, so it can grow without touching its forks. This
holds because:

- a fork point is a position where the machines' state can be rebuilt by folding the facts before
  it: between steps at the least, ideally between turns;
- the parent is never truncated or edited;
- a fact is addressed by the session it lives in and its position there; a position alone is not
  enough, because a fork and its parent each number the facts after the fork point.

### Behaviour as extensions

Compaction strategies, like all other behaviour, are extensions hooked into the core's machines.
The Effect layer orchestrates: it schedules effects, routes messages and observations, and applies
policies. A harness that behaves like Codex, or like Claude Code, would each be a bundle of
policies.

## Open

- The boundary entry is built: `CompactionWindow` records only the span (agent-core S4), and a
  window's summary is a `WindowSummary` (`forks.ts`), held apart; the importers write them to
  `summaries.jsonl`. Which of a window's summaries a request uses, and a live compaction that
  writes one, are not built.
- Forks as sessions, the turn pointer, and addressing facts by session and position are not built.
