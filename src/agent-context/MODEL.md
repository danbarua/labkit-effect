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

### Identity: sessions, windows, forks

Who assigns an identity (the harness or something outside it) is not decided; the records hold
identities as data either way.

Dan's proposal: turn 0 is the init; a root session has `SessionId == ParentId`; every compaction
or fork marks an episode boundary and gets a new session whose journal points back to its parent.
The user sees the root head to tail; the model sees the tail of the latest summarised fork.

What two systems on this machine do (checked in their session files, 2026-09-29):

- Claude Code records compaction inside the same session file, under the same session id: a
  `compact_boundary` record starts a new chain for the model (`parentUuid: null`), links to the
  last message before it (`logicalParentUuid`), names the recent messages kept verbatim, and
  records token counts before and after; the summary is a message marked `isCompactSummary`.
- Codex records compaction as a `compacted` record in the same session, carrying the history the
  model sees from then on, and chains "windows" within the session (`window_id`,
  `previous_window_id`, `first_window_id`). A true fork (a subagent's thread) is a separate session
  with `forked_from_id`.

Where the proposal and those differ:

1. Neither treats compaction as a fork. If compaction made a child session and new facts went into
   it, the root would stop being head to tail, and the person's view would have to stitch root and
   forks together. With compaction as a window record in one journal, "the person sees the
   canonical journal" stays literally true.
2. A fork needs its fork point (which position or turn in the parent), not only the parent's id.
3. Both mark a root by having no parent; `SessionId == ParentId` works as a convention but makes a
   root and a malformed record look the same.

That suggests three identities:

- a session: the canonical journal;
- a window: a compaction's view within a session, with its own identity, the previous window, and
  the positions it covers; spend is summed per window;
- a fork: a new session with `forkedFrom: { session, at }`, for histories that diverge (`/btw`,
  what-if, parallel attempts).

## Open

- Which of these (sessions, windows, forks) gets built first, and what makes the first compaction.
- Who assigns identities.
