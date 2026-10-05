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

- Before a model is picked, the REPL takes `/model`, `/help` and `/exit`. It refuses the other
  commands, `/settings` among them, so the settings cannot be tried before a model is picked until
  `/settings` holds the user's settings (step 4).
- A continued or resumed session whose model cannot be asked is refused at start, saying what to do;
  it does not open the REPL without a model.
- `bun cli models` prints its `HINT:` lines to stderr, so that its stdout is only the models.

## Offering only what a model takes

A host offers only the values that a model takes. A value that a model does not take is refused when
it is set; it is not adjusted when a request is made.

## Settings the user sees

| Setting | Values | Meaning |
| --- | --- | --- |
| model | `provider/model` | The model to ask. |
| effort | the model's efforts, from models.dev; `default` | How much the model reasons. `default` sends nothing: the provider's default applies. |
| thinking | `default`, `disabled` | `default` sends nothing. `disabled` turns the model's thinking off, offered only for a model that can turn it off. |
| `view.thinking` | `on`, `off` | Whether the host shows the model's thinking. It changes nothing in the request. |

- A model whose `reasoning_options` lists a thinking budget and no efforts (Claude Haiku 4.5) offers
  its budget, not an effort.
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
4. The commands, and the thinking key.
5. The adapters rebuilt on models.dev's reasoning data, offering and refusing values instead of
   adjusting them.
