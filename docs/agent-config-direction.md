# Configuration and the CLI: direction

Dan's direction for configuration, model settings and the CLI's model picking (2026-10-05). What is
built is described in [agent-config.md](agent-config.md); the work is listed in order at the end.
Text in quotation marks is Dan's, verbatim.

## The problem

- The CLI is "mostly a refusal-gate". A first run without `--model` is refused, with instructions
  for naming a model, before the user can reach the REPL or try a command.
- `policies.yml` is the only configuration file, and it can name plug-ins, seam lists, MCP servers
  and extensions, but not a model or its settings. "`policies.yml` is for policies, not a dumping
  ground for all configuration."
- A user faces four settings that interact: effort, thinking, maximum output tokens and a thinking
  budget. The adapters adjust values that a model does not take, and record some adjustments but not
  all of them. The adjustments were written before the typed catalog of models existed.

## Built

The configuration folder (every `.yml` file, in name order), the example files in
`src/agent-config/fixtures/`, models.dev's reasoning data, and `model` and `models` overrides are
built: see [agent-config.md](agent-config.md), Layers and Models.

The CLI's start without a model, `bun cli models` and its `ERROR:` and `HINT:` messages are built,
as the header of `src/examples/cli-repl/index.ts` describes, with these limits:

- Before a model is picked, the REPL takes `/model`, `/switch`, `/settings` (the user's settings
  only), `/help` and `/exit`, and Option+T. It refuses the other commands.
- A continued or resumed session whose model cannot be asked is refused at start, saying what to do;
  it does not open the REPL without a model.
- `bun cli models` prints its `HINT:` lines to stderr, so that its stdout is only the models.
- A mistake in a flag (a flag the CLI does not know, a value the flag does not take) is printed as
  an `ERROR:` line, but effect/cli first prints the whole help to stdout.

The commands and the thinking key are built: each command is in its own file in
`src/examples/cli-repl/commands/`, which describes it, and Option+T is in `view.ts`. Writing a
setting into the user's folder is described in [agent-config.md](agent-config.md), Writing into the
user's folder. Their limits:

- Option+T shows or hides the model's thinking (`view.thinking`) until the REPL exits, and writes
  nothing; `/settings view.thinking=…` writes it. No key turns thinking off in the request:
  `/settings thinking=disabled` does.
- The user's settings are `view.thinking` only.

## Offering what a model takes, and translating intent

Rulings of 2026-10-06, which revise "refusing values instead of adjusting them":

- A host offers, and takes, only the values that the current model takes: the CLI's completion,
  pickers, typed settings and flags, and ACP's selects. "The UI can configure itself to only show
  the valid options to the user." What a model takes comes from models.dev, the measured entries,
  and the user's `models:` overrides.
- A setting is the intent of whoever set it. A model change, from a person or from a policy (a
  headless run, a fallback model), carries the settings over and never refuses them, so that a run
  can go on without anyone reconfiguring it. Dan: "not willing to turn the software into an
  automated Refusal-Gate-Refuse factory".
- At each request, the provider's adapter translates a value that the model does not take: to the
  nearest value that it takes (an effort above the model's highest is sent as its highest; of two
  equally near efforts, the higher), or to nothing when the model has no counterpart. Each
  translation is recorded (`SettingAdjusted`).
- Sessions recorded with the earlier values (thinking `auto`, `off`, `before_answer`) are not
  migrated, and do not open.
- A run's starting configuration is valid, or the run does not start: a setting on the command line
  that the model does not take fails the run, with or without `-p`, and says what the model takes.
  Dan: "When launching headless, either the config was valid and the run does the work until
  completion or failure, or the config was not valid."
- A setting is the user's intent; what a provider is sent is its effect, and the adapter maps one to
  the other. A thinking budget is not a setting: Claude Haiku 4.5, which takes a budget in place of
  an effort, is sent each effort as a budget, a multiple of its least budget (1,024 tokens): `low`
  1x, `medium` 4x, `high` 16x, `xhigh` 32x, and `max` the largest the request allows. `minimal` is
  sent as `low`.

Built (step 5): the adapters read what a model takes from models.dev (`effortsTaken`,
`turnsThinkingOff`, `src/agent-session/configuration/well-known-models.ts`) and the measured
entries (`between_tools`); a host offers and takes those values and `default`; the CLI's flags,
`/settings` and `/effort` refuse a value the model does not take; ACP's `not_sent` is `default`;
the output limit defaults to the model's own.

## Settings the user sees

| Setting | Values | Meaning |
| --- | --- | --- |
| model | `provider/model` | The model to ask. |
| effort | `default`; the model's efforts, from models.dev, except `none` | How much the model reasons. `default` sends nothing: the provider's default applies. `none` is `thinking=disabled`. |
| thinking | `default`, `disabled`, `between_tools` | `default` sends nothing. `disabled` turns the model's thinking off, offered for a model that can turn it off: its efforts list `none`, or it takes a budget. `between_tools` thinks only between tool calls, offered for a model measured to take it (Claude Sonnet 5.5). |
| `view.thinking` | `on`, `off` | Whether the host shows the model's thinking. It changes nothing in the request. |

- The maximum number of output tokens is not a setting that a user must choose. It defaults to the
  model's output limit from models.dev, and a configuration file can override it. Later, the
  runtime may lower it near the end of the context window, to keep room for compaction. ACP's
  config options require a value, so the ACP host offers it, preset to the model's limit.
- `auto` is reserved for later: a local classifier model estimates the effort that a request needs.

## The CLI

### Starting

- A session at a terminal starts the REPL even when no model is configured, so the user can try the
  commands and settings first.
- Starting a turn with no model, or with a model whose provider's key is not in the environment, is
  refused, saying what to do: configure another model, or restart with the key set.
- A headless run (`-p`) is refused at once when no model is configured.

### Commands

| Command | What it does |
| --- | --- |
| `/model` | Sets the user's default model for every session, and writes it to `models.yml`. |
| `/switch` | Changes the model for this session only. |
| `/settings` | Shows and changes the user's settings, not only the next request's model settings. |
| `/effort` | Sets the effort; repeated, it cycles through the model's efforts. |

Thinking is toggled with a key, as Claude Code does with Option+T and pi with Shift+Tab.

### Messages

- An error is a short `ERROR:` line, followed by a `HINT:` line when there is something to do:

  ```
  ERROR: --model is required.
  HINT: bun cli models shows available models discovered from the environment.
  ```

- A message shown outside the REPL never tells the user to run a slash command.
- `bun cli models` lists one model per line, as `--model` takes it (`provider/model`), and only the
  providers that can be used now. A provider whose key is not set is named in a `HINT:` line.

## Order of work

1. The configuration folder, and its example files. Built.
2. `models.yml`: models.dev's data as the defaults, and the user's overrides. Built.
3. The REPL without a model; `bun cli models` and the error messages. Built, with the limits
   listed under Built.
4. The commands, and the thinking key. Built, with the limits listed under Built.
5. The adapters rebuilt on models.dev's reasoning data. Built: see Offering what a model takes,
   which revises "offering and refusing values instead of adjusting them".
