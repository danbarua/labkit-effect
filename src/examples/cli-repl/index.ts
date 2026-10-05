/**
 * A command-line agent, as a walking skeleton for configuration, context assembly and the loop:
 * `bun cli` is a REPL; `bun cli -p "Hello"` asks once, prints the answer and exits. Its flags follow
 * Claude Code's CLI (https://code.claude.com/docs/en/cli-reference); the ones not built yet are
 * kept here, commented out, and the ones only Claude Code has are left out.
 *
 * The model is `--model`: a well-known model, found with its provider, or `provider/model` (`localhost/<model>` is a local
 * Chat Completions server at http://localhost:8000/v1). With no model there is nothing to ask:
 * `bun cli models` lists them, and which providers have a key set (`ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`, `XAI_API_KEY`).
 *
 * A session runs through the loop as any other: its opening holds the model, its settings and the
 * system prompt; each input is the user's, through the CLI; the conversation is every turn of it.
 * With `--output-format json` the answer comes with the session's figures; with `stream-json` each
 * fact is printed as it is recorded, then the result.
 *
 * Its policies, turn-end hooks and MCP servers are its configuration (`configuration.ts`): its own
 * defaults, the files of the user's configuration folder (`~/.config/<brand>/`, or `--config-dir`),
 * the project's and the local ones (in `.<brand>/` in the folder it runs in) when `--setting-sources`
 * names them, `--settings`,
 * `--mcp-config`, then the flags
 * (`--permission-mode`, `--max-turns`, `--max-budget-usd`), the last write winning. What it resolved
 * to, and which layer said each value, is written to the session's folder as
 * `effective-settings.json`.
 *
 * Each session's facts and log are kept in `logs/cli/<session>/` (`agent-host/directory.ts`); `--continue` goes on from the
 * one written to last, `--resume <session>` from the one named (with no id, one picked from a list), so `bun run cli:watch --continue` restarts on a change to the code and
 * keeps the conversation.
 *
 * It runs as the brand `main` is given, else the one the environment names (`LABKIT_BRAND`), else
 * labkit (`agent-host/brand.ts`): the brand names its command and its folders. The options it shares
 * with the ACP launcher (`agent-host/launch.ts`) are read from their variables when not given:
 * `--max-turns` from `LABKIT_MAX_TURNS`, and so on.
 *
 * Calling it from an agent's shell tool, use `-p` with the prompt as an argument: without `-p` the
 * REPL waits for input, and without a prompt `-p` reads it from stdin to its end. `bun --silent
 * cli` keeps bun's echo of the script off stdout.
 */

import { cliConfiguration } from "./configuration.ts";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { ConfigProvider, Console, Effect, Option, Stdio, Stream } from "effect";
import { Argument, Command, Flag, Prompt } from "effect/cli";
import { Effort, ThinkingMode } from "../../agent-machine/settings.ts";
import { settingsGiven } from "./commands.ts";
import { modelOf } from "../../agent-session/configuration/session-setup.ts";
import { KeyedAndLocalCatalog, keyOf, keyVariables, known, ModelCatalog } from "../../agent-host/catalog.ts";
import { latestSession, readSession, storedSessions, summaryOf } from "../../agent-host/directory.ts";
import { LogsToFile, LogsToStderr } from "../../agent-host/logs.ts";
import { Brand, brandFrom } from "../../agent-host/brand.ts";
import { launchFlags, launchVariables } from "../../agent-host/launch.ts";
import { invalid } from "./invalid.ts";
import { targetOf } from "./models.ts";
import { printOnce } from "./print.ts";
import { repl, Terminal } from "./repl.ts";
import { type Config, Headless, logFileOf, storeFolder, withSession } from "./session.ts";

const optional = <A>(flag: Flag.Flag<A>) => flag.pipe(Flag.optional, Flag.map(Option.getOrUndefined));
const text = (name: string, description: string, ...aliases: Array<string>) =>
  optional(aliases.reduce((flag, alias) => flag.pipe(Flag.withAlias(alias)), Flag.String(name).pipe(Flag.withDescription(description))));
const toggle = (name: string, description: string, ...aliases: Array<string>) =>
  aliases.reduce((flag, alias) => flag.pipe(Flag.withAlias(alias)), Flag.Boolean(name).pipe(Flag.withDescription(description), Flag.withDefault(false)));
const choice = <const A extends ReadonlyArray<string>>(name: string, values: A, description: string) =>
  optional(Flag.Literals(name, values).pipe(Flag.withDescription(description)));
const arg = (name: string) => Argument.String(name).pipe(Argument.optional, Argument.map(Option.getOrUndefined));

const flags = {
  print: toggle("print", "Ask once, print the answer and exit", "p"),
  effort: choice("effort", [...Effort.literals, "none"], "Reasoning effort; a model that does not take it is sent the nearest it does; none is --thinking off"),
  thinking: choice("thinking", ThinkingMode.literals, "When the model thinks"),
  systemPrompt: text("system-prompt", "The system prompt"),
  systemPromptFile: text("system-prompt-file", "A file holding the system prompt"),
  appendSystemPrompt: text("append-system-prompt", "Text added after the system prompt"),
  appendSystemPromptFile: text("append-system-prompt-file", "A file whose text is added after the system prompt"),
  outputFormat: choice("output-format", ["text", "json", "stream-json"], "How the answer is printed (print mode)"),
  verbose: toggle("verbose", "Print the session's facts as they are recorded"),
  continue: toggle("continue", "Continue the latest conversation", "c"),
  resume: text("resume", "Resume a session by its id; with none, pick one from a list", "r"),
  noSessionPersistence: toggle("no-session-persistence", "Keep the session's facts in memory only, not in its file"),
  sessionId: text("session-id", "The new session's id"),
  // The options the ACP launcher takes too, each with its variable as its twin.
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

/** The system prompt the flags give: the prompt or its file, then the appended text or its file. */
const systemOf = (options: Options) =>
  Effect.gen(function* () {
    const read = (path: string | undefined) => (path === undefined ? Effect.undefined : Effect.promise(() => Bun.file(path).text()));
    const base = options.systemPrompt ?? (yield* read(options.systemPromptFile));
    const appended = options.appendSystemPrompt ?? (yield* read(options.appendSystemPromptFile));
    const parts = [base, appended].filter((part): part is string => part !== undefined && part !== "");
    return parts.length === 0 ? undefined : parts.join("\n\n");
  });

/** When it was, as a short local date and time. */
const shortly = (at: Date | undefined): string => (at === undefined ? "?" : at.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }));

/**
 * The session `--resume` names, or with none, the one picked from the store's, the one written to
 * last first, each with its turns and the model it asks. A session whose file does not read is
 * listed as such.
 */
const resumed = (named: string, interactive: boolean) =>
  Effect.gen(function* () {
    if (named !== "") return yield* readSession(storeFolder, named);
    if (!interactive) return yield* invalid("--resume needs a session id when there is no terminal to pick one at.");
    const stored = yield* storedSessions(storeFolder);
    if (stored.length === 0) return yield* invalid(`No session to resume: ${storeFolder} holds none.`);
    const choices = yield* Effect.forEach(stored, ({ sessionId, at }) =>
      readSession(storeFolder, sessionId).pipe(
        Effect.flatMap(({ facts }) => summaryOf(facts)),
        Effect.map(({ turns, model }) => `${shortly(at)}  ${turns} turn${turns === 1 ? "" : "s"}  ${model}  ${sessionId}`),
        Effect.orElseSucceed(() => `${shortly(at)}  (does not read)  ${sessionId}`),
        Effect.map((title) => ({ title, value: sessionId })),
      ),
    );
    return yield* readSession(storeFolder, yield* Prompt.Select({ message: "Resume which session?", choices }));
  });

/**
 * The session's configuration, as the flags give it. A new session asks the model that `--model`
 * names, else the configuration's (`model:`). With `--continue`, the session written to last, or
 * with `--resume`, the one it names or the one picked, asking the model `--model` names or the one it
 * asked; the settings are the ones the flags name, which change those it had.
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
    if (options.continue && options.resume !== undefined) return yield* invalid("Pass --continue or --resume, not both.");
    if (!options.continue && options.resume === undefined) {
      const config: Config = { sessionId: options.sessionId ?? crypto.randomUUID(), target: yield* targetOf(options.model ?? configuration.model), settings, system, ...permissions };
      return config;
    }
    if (options.sessionId !== undefined) return yield* invalid("--session-id names a new session: a continued or resumed one keeps its own.");
    if (system !== undefined) return yield* invalid("A continued session keeps the system prompt it opened with: all sessions have ImmutableSystemPrompt until further notice.");
    const latest = options.resume === undefined ? yield* latestSession(storeFolder) : yield* resumed(options.resume, interactive);
    const now = yield* modelOf(latest.facts);
    const config: Config = { sessionId: latest.sessionId, target: yield* targetOf(options.model ?? `${now.provider}/${now.model}`), settings, system, continues: latest.facts, ...permissions };
    return config;
  }).pipe(
    Effect.catchTags({
      DirectoryUnreadable: (error) => Effect.fail(invalid(`The session store could not be read: ${error.message}`)),
      SessionNotFound: (error) => Effect.fail(invalid(`No session ${error.sessionId} in ${error.root}.`)),
      NoSessionStored: (error) => Effect.fail(invalid(`No session to continue: ${error.root} holds none.`)),
      SessionStoreFailed: (error) => Effect.fail(invalid(error.message)),
      ConfigInvalid: (error) => Effect.fail(invalid(`The configuration cannot be used: ${error.message}`)),
    }),
  );

/** A provider's models as the list says them: not answering, none, or their names. */
const modelsSaid = (models: ReadonlyArray<string> | undefined): string => {
  if (models === undefined) return "not answering";
  return models.length === 0 ? "no models" : models.join(", ");
};

/** The CLI, called by `brand`'s name. */
export const cliOf = (brand: Brand) =>
  Command.make(
    brand.name,
    { prompt: arg("prompt"), ...flags },
    Effect.fnUntraced(function* (options) {
      const stdio = yield* Stdio.Stdio;
      const interactive = yield* stdio.stdinIsTerminal;
      const config = yield* configOf(options, interactive);
      if (!options.print)
        return yield* withSession(config, LogsToFile(logFileOf(config.sessionId)), interactive ? Terminal : Headless, (session, mcp) => repl(session, config, options.prompt, interactive, mcp));
      // Piped input is read only when no prompt was given: a shell that leaves stdin open would
      // otherwise keep a prompted run waiting for an end of input that never comes.
      const prompt = options.prompt ?? (interactive ? "" : yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString));
      // Said before the session opens, so a run with nothing to ask leaves no session behind.
      if (prompt === "") return yield* invalid("No prompt: pass one, or pipe it in.");
      yield* withSession(config, LogsToStderr, Headless, (session) => printOnce(session, config, prompt, options.outputFormat ?? "text", options.verbose));
    }),
  ).pipe(
    Command.withDescription("An agent at the command line: a REPL, or -p to ask once."),
    Command.withExamples([
      { command: `${brand.name} -p "Hello" --model claude-sonnet-5-5`, description: "Ask once and print the answer" },
      { command: `${brand.name} -p "Hello" --model gpt-5.5 --output-format json`, description: "The answer with the session's figures" },
      { command: `${brand.name} --model localhost/mlx-community/Qwen3.5-9B-8bit`, description: "A REPL with a local model" },
      { command: `${brand.name} models`, description: "The known models, which providers have a key set, and the local server's models" },
    ]),
    Command.withSubcommands([
      Command.make("models", {}, () =>
        Effect.gen(function* () {
          yield* Effect.forEach(
            Object.entries(known),
            ([provider, listed]) => Console.log(`${provider} (${keyOf(provider) === undefined ? `no ${keyVariables[provider] ?? "key"}` : "key set"}): ${Object.keys(listed).join(", ")}`),
            { discard: true },
          );
          const sources = yield* (yield* ModelCatalog).sources;
          yield* Effect.forEach(
            sources.filter(({ provider }) => !(provider in known)),
            ({ provider, models, at }) =>
              Console.log(`${provider}${at === undefined ? "" : ` (${at})`}: ${modelsSaid(models)}`),
            { discard: true },
          );
          yield* Console.log("Name a model with --model or /model as it is listed here, or as provider/model: openai/gpt-5.5, localhost/<a local model>.");
        }),
      ).pipe(Command.withDescription("The known models, which providers have a key set, and the local server's models")),
    ]),
  );

/**
 * `args` with an empty value after `--resume` (`-r`) where none was given, so that the flag alone
 * asks for a session to be picked: a flag's value cannot be left out otherwise.
 */
export const withResumeValue = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.flatMap((arg, at) => {
    const next = args[at + 1];
    return (arg === "--resume" || arg === "-r") && (next === undefined || next.startsWith("-")) ? [arg, ""] : [arg];
  });

/**
 * Runs the CLI with `args`, as `brand` (the one the environment names, else the default, when not
 * given); the model catalog is the well-known models whose provider has a key set, and the local
 * server's.
 */
export const run = (args: ReadonlyArray<string>, brand: Brand = brandFrom(process.env)) =>
  Command.runWith(cliOf(brand), { version: brand.version })(withResumeValue(args)).pipe(
    Effect.provide(KeyedAndLocalCatalog),
    Effect.provideService(Brand, brand),
    Effect.provideService(ConfigProvider.ConfigProvider, launchVariables(brand)),
  );

/** Runs the CLI with this process's arguments, as `brand`: a package's bin gives its own. */
export const main = (brand: Brand = brandFrom(process.env)) => run(process.argv.slice(2), brand).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);

if (import.meta.main) main();
