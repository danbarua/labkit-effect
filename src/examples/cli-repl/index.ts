/**
 * A command-line agent, built as a walking skeleton for configuration, context assembly and the
 * loop. `bun cli` starts a REPL; `bun cli -p "Hello"` answers one prompt and exits. The flags follow
 * Claude Code's CLI (https://code.claude.com/docs/en/cli-reference): flags not built yet are listed
 * here, commented out, and flags only Claude Code has are left out.
 *
 * The model is the one `--model` names, else the configuration's `model:`: a well-known model, or
 * `provider/model` (`localhost/<model>` is a local Chat Completions server at
 * http://localhost:8000/v1). `bun cli models` prints the usable models to stdout, one per line, and
 * to stderr a `HINT:` line for each provider without an API key (`ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`, `XAI_API_KEY`) and for a local server that does not respond. When the model
 * cannot be used (none is named, its provider has no key, or its server does not respond):
 *
 * - with `-p`, without a terminal, or when continuing or resuming a session, the CLI exits with an
 *   error;
 * - at a terminal, a new session's REPL opens without a model (`withoutModel` in `repl.ts`), and the
 *   session opens once `/model` or `/switch` picks a usable model.
 *
 * Errors are printed as an `ERROR:` line and a `HINT:` line for each thing the user can do
 * (`invalid.ts`). A hint printed outside the REPL names no slash command.
 *
 * With `--output-format json`, the answer is printed with the session's usage and cost; with
 * `stream-json`, each fact is printed as it is recorded, then the result.
 *
 * The configuration (`configuration.ts`) is made of layers, the last one winning: the CLI's defaults;
 * the files in the user's configuration folder (`~/.config/<brand>/`, or `--config-dir`); the
 * project's and local files (in `.<brand>/` in the working folder) when `--setting-sources` names
 * them; `--settings`; `--mcp-config`; then the flags (`--permission-mode`, `--max-turns`,
 * `--max-budget-usd`). The resolved configuration, and the layer each value came from, is written to
 * the session's folder as `effective-settings.json`.
 *
 * Each session's facts are kept in `~/.local/share/<brand>/sessions/<version>/<session>/`, a folder
 * that the ACP host shares, and its log in `~/.local/share/<brand>/logs/cli-<session>.log`
 * (`agent-host/brand.ts`). `--continue` and the `--resume` picker offer the CLI's sessions made in
 * the working folder.
 * `--continue` continues the most recently written session, and `--resume <session>` the one named
 * (with no ID, the user picks one from a list). `bun run cli:watch --continue` therefore restarts
 * on each code change and keeps the conversation.
 *
 * The brand is the one passed to `main`, else `LABKIT_BRAND`, else labkit (`agent-host/brand.ts`); it
 * names the command and its folders. Options shared with the ACP launcher (`agent-host/launch.ts`)
 * fall back to environment variables: `--max-turns` to `LABKIT_MAX_TURNS`, and so on.
 *
 * From an agent's shell tool, use `-p` with the prompt as an argument: without `-p` the REPL waits
 * for input, and `-p` without a prompt reads stdin to its end. `bun --silent cli` keeps bun's echo of
 * the script off stdout.
 */

import { cliConfiguration } from "./configuration.ts";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { ConfigProvider, Console, Effect, Layer, Option, Result, Stdio, Stream } from "effect";
import { Argument, CliOutput, Command, Flag, Prompt } from "effect/cli";
import { Effort, ThinkingMode } from "../../agent-machine/settings.ts";
import { knowledgeWith, settingsGiven, takenBy } from "./model-settings.ts";
import { modelOf } from "../../agent-session/configuration/session-setup.ts";
import { askable, KeyedAndLocalCatalog, ModelCatalog } from "../../agent-host/catalog.ts";
import { NoSessionStored, readSession, summaryOf } from "../../agent-host/directory.ts";
import { recordedSessions } from "../../agent-host/record.ts";
import { LogsToFile, LogsToStderr } from "../../agent-host/logs.ts";
import { OtlpSpansAndMetrics } from "../../instrumentation/telemetry.ts";
import { Brand, brandFrom } from "../../agent-host/brand.ts";
import { launchFlags, launchVariables, userFolderOf } from "../../agent-host/launch.ts";
import { invalid, saidFormatter } from "./invalid.ts";
import { askedOf, targetOf, unavailable } from "./models.ts";
import { printOnce } from "./print.ts";
import { repl, type ReplContext, terminal, withoutModel } from "./repl.ts";
import { viewOf } from "./view.ts";
import { type Config, Headless, logFileOf, madeIn, storeFolderOf, withSession } from "./session.ts";

const optional = <A>(flag: Flag.Flag<A>) => flag.pipe(Flag.optional, Flag.map(Option.getOrUndefined));
const text = (name: string, description: string, ...aliases: Array<string>) =>
  optional(aliases.reduce((flag, alias) => flag.pipe(Flag.withAlias(alias)), Flag.String(name).pipe(Flag.withDescription(description))));
const toggle = (name: string, description: string, ...aliases: Array<string>) =>
  aliases.reduce((flag, alias) => flag.pipe(Flag.withAlias(alias)), Flag.Boolean(name).pipe(Flag.withDescription(description), Flag.withDefault(false)));
const choice = <const A extends ReadonlyArray<string>>(name: string, values: A, description: string) =>
  optional(Flag.Literals(name, values).pipe(Flag.withDescription(description)));
const arg = (name: string) => Argument.String(name).pipe(Argument.optional, Argument.map(Option.getOrUndefined));

const flags = {
  print: toggle("print", "Answer one prompt, print the answer, and exit", "p"),
  effort: choice("effort", ["default", ...Effort.literals], "Reasoning effort; default leaves it to the provider"),
  thinking: choice("thinking", ["default", ...ThinkingMode.literals], "Thinking mode; default leaves it to the provider"),
  systemPrompt: text("system-prompt", "The system prompt, after the line that names the working folder"),
  systemPromptFile: text("system-prompt-file", "Read the system prompt from a file"),
  appendSystemPrompt: text("append-system-prompt", "Append text to the system prompt"),
  appendSystemPromptFile: text("append-system-prompt-file", "Append a file's text to the system prompt"),
  outputFormat: choice("output-format", ["text", "json", "stream-json"], "Output format with -p"),
  verbose: toggle("verbose", "Print the session's events as they are recorded"),
  continue: toggle("continue", "Continue the latest conversation", "c"),
  resume: text("resume", "Resume a session by ID, or pick one from a list", "r"),
  noSessionPersistence: toggle("no-session-persistence", "Do not save the session to disk"),
  sessionId: text("session-id", "ID for the new session"),
  // Options shared with the ACP launcher, each with an environment variable as its fallback.
  ...launchFlags,
  // Not built yet:
  // name: text("name", "Session display name", "n"),
  // forkSession: toggle("fork-session", "Fork the continued or resumed session"),
  // fallbackModel: text("fallback-model", "Comma-separated fallback models"),
  // autocompact: text("autocompact", "Auto-compact window: auto, a token count or a percentage"),
  // tools: list("tools", "Tool names, default, or an empty string"),
  // allowedTools: list("allowedTools", "Tool permission allow rules", "allowed-tools"),
  // disallowedTools: list("disallowedTools", "Tool permission deny rules", "disallowed-tools"),
  // permissionPromptTool: text("permission-prompt-tool", "MCP permission handler (print mode)"),
  // addDir: list("add-dir", "Additional working directories"),
  // agents: text("agents", "Custom agent definitions as JSON or a JSON file path"),
  // agent: text("agent", "Agent to use for this session"),
  // inputFormat: choice("input-format", ["text", "stream-json"], "Input encoding (print mode)"),
  // jsonSchema: text("json-schema", "Structured output schema"),
  // includePartialMessages: toggle("include-partial-messages", "Print partial stream events"),
  // debug: text("debug", "Enable diagnostics for categories"),
  // debugFile: text("debug-file", "Debug log destination"),
};

type Options = Command.Command.Config.Infer<typeof flags>;

/** Returns the system prompt from the flags: the prompt or its file, then the appended text or its file. */
const systemOf = (options: Options) =>
  Effect.gen(function* () {
    const read = (path: string | undefined) => (path === undefined ? Effect.undefined : Effect.promise(() => Bun.file(path).text()));
    const base = options.systemPrompt ?? (yield* read(options.systemPromptFile));
    const appended = options.appendSystemPrompt ?? (yield* read(options.appendSystemPromptFile));
    const parts = [base, appended].filter((part): part is string => part !== undefined && part !== "");
    return parts.length === 0 ? undefined : parts.join("\n\n");
  });

/** Formats `at` as a short local date and time. */
const shortly = (at: Date | undefined): string => (at === undefined ? "?" : at.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }));

/**
 * Returns the session `--resume` names; with no name, the one the user picks from a list of the saved
 * sessions, newest first, each with its turn count and model. A session whose file cannot be read is
 * listed as unreadable.
 */
const resumed = (named: string, interactive: boolean, root: string) =>
  Effect.gen(function* () {
    if (named !== "") return yield* readSession(root, named);
    if (!interactive) return yield* invalid("--resume needs a session ID when input is not a terminal.", "Pass --resume <session-id>.");
    const stored = yield* savedHere(root);
    if (stored.length === 0) return yield* invalid("No saved sessions for this folder.");
    const choices = yield* Effect.forEach(stored, ({ sessionId, at }) =>
      readSession(root, sessionId).pipe(
        Effect.flatMap(({ facts }) => summaryOf(facts)),
        Effect.map(({ turns, model }) => `${shortly(at)}  ${turns} turn${turns === 1 ? "" : "s"}  ${model}  ${sessionId}`),
        Effect.orElseSucceed(() => `${shortly(at)}  (does not read)  ${sessionId}`),
        Effect.map((title) => ({ title, value: sessionId })),
      ),
    );
    return yield* readSession(root, yield* Prompt.Select({ message: "Resume which session?", choices }));
  });

/** The CLI's sessions made in this working folder (`madeIn`), the one written to last first. */
const savedHere = (root: string) => Effect.map(recordedSessions(root), (stored) => stored.filter(({ record }) => madeIn(record, process.cwd())));

/** The CLI's session made in this working folder that was written to last. */
const latestHere = (root: string) =>
  Effect.gen(function* () {
    const latest = (yield* savedHere(root))[0];
    if (latest === undefined) return yield* new NoSessionStored({ root });
    return yield* readSession(root, latest.sessionId);
  });

/** A session's configuration before its model is looked up: the model's name (`named`), undefined when none is given. */
type Unresolved = Omit<Config, "target"> & { readonly named: string | undefined };

/**
 * Returns the session's configuration from the flags, with the name of its model. A new session uses
 * `--model`, else the configuration's `model:`. `--continue` continues the most recently written
 * session and `--resume` the named or picked one, with `--model` or the session's own model; the
 * settings the flags name change the session's settings.
 */
const configOf = (options: Options, interactive: boolean) =>
  Effect.gen(function* () {
    const brand = yield* Brand;
    const configuration = yield* cliConfiguration(process.cwd(), options, { name: brand.name });
    const permissions = {
      configuration,
      canAsk: interactive && !options.print,
      persist: !options.noSessionPersistence,
      strictToolInput: options.strictToolInput,
    } as const;
    const settings = yield* settingsGiven({
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
    });
    const system = yield* systemOf(options);
    if (options.continue && options.resume !== undefined) return yield* invalid("--continue and --resume cannot be used together.");
    if (!options.continue && options.resume === undefined) {
      const config: Unresolved = { sessionId: options.sessionId ?? crypto.randomUUID(), named: options.model ?? configuration.model, settings, system, ...permissions };
      return config;
    }
    if (options.sessionId !== undefined) return yield* invalid("--session-id cannot be used with --continue or --resume.", "A continued session keeps its own ID.");
    if (system !== undefined) return yield* invalid("A continued session cannot change its system prompt.", "Start a new session to use another system prompt.");
    const root = storeFolderOf(yield* Brand);
    const latest = options.resume === undefined ? yield* latestHere(root) : yield* resumed(options.resume, interactive, root);
    const now = yield* modelOf(latest.facts);
    const config: Unresolved = { sessionId: latest.sessionId, named: options.model ?? `${now.provider}/${now.model}`, settings, system, continues: latest.facts, ...permissions };
    return config;
  }).pipe(
    Effect.catchTags({
      DirectoryUnreadable: (error) => Effect.fail(invalid(`Could not read the saved sessions: ${error.message}`)),
      SessionNotFound: (error) => Effect.fail(invalid(`Session ${error.sessionId} not found in ${error.root}.`, "--resume with no ID lists the saved sessions.")),
      NoSessionStored: () => Effect.fail(invalid("No saved session for this folder to continue.", "Start a new session without --continue.")),
      SessionStoreFailed: (error) => Effect.fail(invalid(error.message)),
      ConfigInvalid: (error) => Effect.fail(invalid(`Invalid configuration: ${error.message}`)),
    }),
  );

/**
 * Returns `config` when its model supports each setting given on the command line (`takenBy`),
 * checked against what a session knows of models, with the configuration's overrides. A setting the
 * model does not support fails the run before the session opens, with or without `-p`: a run starts
 * with valid settings or not at all.
 */
const checked = (config: Config) =>
  Effect.gen(function* () {
    const settings = config.continues === undefined ? undefined : (yield* modelOf(config.continues)).settings;
    yield* takenBy({ ...config.target, ...(settings === undefined ? {} : { settings }) }, config.settings, "the command line").pipe(Effect.provide(knowledgeWith(config.configuration.models)));
    return config;
  });

/** The CLI, as a command named after `brand`. */
export const cliOf = (brand: Brand) =>
  Command.make(
    brand.name,
    { prompt: arg("prompt"), ...flags },
    Effect.fnUntraced(function* (options) {
      const stdio = yield* Stdio.Stdio;
      const interactive = yield* stdio.stdinIsTerminal;
      const { named, ...unresolved } = yield* configOf(options, interactive);
      const context: ReplContext = {
        configFolder: userFolderOf(options, { name: (yield* Brand).name }),
        view: yield* viewOf(unresolved.configuration.cli.view.thinking),
        commandLine: unresolved.settings,
      };
      // At a terminal, a new session whose model cannot be used opens the REPL without a model.
      if (interactive && !options.print && unresolved.continues === undefined) {
        const found = yield* Effect.result(askedOf(named, "/model"));
        const target = Result.isSuccess(found)
          ? found.success
          : yield* withoutModel(found.failure, options.prompt, context, unresolved.configuration.layers).pipe(Effect.provide(knowledgeWith(unresolved.configuration.models)));
        if (target === undefined) return;
        const config: Config = yield* checked({ ...unresolved, target });
        // A prompt given on the command line was not sent when the REPL opened without a model, so it is dropped.
        const first = Result.isSuccess(found) ? options.prompt : undefined;
        return yield* withSession(config, LogsToFile(logFileOf(brand, config.sessionId), `${brand.name}-cli`), terminal(context.view), (session, mcp) => repl(session, config, first, interactive, context, mcp));
      }
      const config: Config = yield* checked({ ...unresolved, target: yield* targetOf(named, "--model") });
      if (!options.print)
        return yield* withSession(config, LogsToFile(logFileOf(brand, config.sessionId), `${brand.name}-cli`), interactive ? terminal(context.view) : Headless, (session, mcp) => repl(session, config, options.prompt, interactive, context, mcp));
      // Piped input is read only when no prompt was given: a shell that leaves stdin open would
      // otherwise keep a prompted run waiting for an end of input that never comes.
      const prompt = options.prompt ?? (interactive ? "" : yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString));
      // Checked before the session opens, so a run with no prompt saves no session.
      if (prompt === "") return yield* invalid("No prompt given.", "Pass the prompt as an argument, or pipe it to stdin.");
      yield* withSession(config, LogsToStderr(`${brand.name}-cli`), Headless, (session) => printOnce(session, config, prompt, options.outputFormat ?? "text", options.verbose));
    }),
  ).pipe(
    Command.withDescription("A coding agent: an interactive REPL, or -p to answer one prompt and exit."),
    Command.withExamples([
      { command: `${brand.name} -p "Hello" --model claude-sonnet-5-5`, description: "Ask once and print the answer" },
      { command: `${brand.name} -p "Hello" --model gpt-5.5 --output-format json`, description: "The answer with the session's figures" },
      { command: `${brand.name} --model localhost/mlx-community/Qwen3.5-9B-8bit`, description: "A REPL with a local model" },
      { command: `${brand.name} models`, description: "List the models you can use, one per line" },
    ]),
    Command.withSubcommands([
      // Models go to stdout so they can be piped; hints go to stderr.
      Command.make("models", {}, () =>
        Effect.gen(function* () {
          yield* Effect.forEach(yield* askable, ({ provider, model }) => Console.log(`${provider}/${model}`), { discard: true });
          yield* Effect.forEach(unavailable(yield* (yield* ModelCatalog).sources), (hint) => Console.error(`HINT: ${hint}`), { discard: true });
        }),
      ).pipe(Command.withDescription("List the models you can use, one per line")),
    ]),
  );

/**
 * Returns `args` with an empty value added after a bare `--resume` (`-r`), so that the flag alone
 * offers a session picker: effect/cli does not allow a flag's value to be omitted.
 */
export const withResumeValue = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.flatMap((arg, at) => {
    const next = args[at + 1];
    return (arg === "--resume" || arg === "-r") && (next === undefined || next.startsWith("-")) ? [arg, ""] : [arg];
  });

/**
 * Runs the CLI with `args` as `brand` (by default, the brand the environment names, else labkit). The
 * usable models are the well-known models whose provider has an API key, and the local server's.
 */
export const run = (args: ReadonlyArray<string>, brand: Brand = brandFrom(process.env)) =>
  Command.runWith(cliOf(brand), { version: brand.version })(withResumeValue(args)).pipe(
    Effect.provide(Layer.mergeAll(CliOutput.layer(saidFormatter), KeyedAndLocalCatalog)),
    Effect.provideService(Brand, brand),
    Effect.provideService(ConfigProvider.ConfigProvider, launchVariables(brand)),
  );

/** Runs the CLI with this process's arguments, as `brand`; a package's bin passes its own brand. */
export const main = (brand: Brand = brandFrom(process.env)) =>
  run(process.argv.slice(2), brand).pipe(Effect.provide(Layer.mergeAll(OtlpSpansAndMetrics(`${brand.name}-cli`), BunServices.layer)), BunRuntime.runMain);

if (import.meta.main) main();
