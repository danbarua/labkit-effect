/**
 * A command-line agent, as a walking skeleton for configuration, context assembly and the loop:
 * `bun cli` is a REPL; `bun cli -p "Hello"` asks once, prints the answer and exits. Its flags follow
 * Claude Code's CLI (https://code.claude.com/docs/en/cli-reference); the ones not built yet are
 * kept here, commented out, and the ones only Claude Code has are left out.
 *
 * The model is `--model`: a model in `models.json` (the frontier models, a link to the providers'
 * `frontier.json`), found with its provider, or `provider/model` (`localhost/<model>` is a local
 * Chat Completions server at http://localhost:8000/v1). With no model there is nothing to ask:
 * `bun cli models` lists them, and which providers have a key set (`ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`, `XAI_API_KEY`).
 *
 * A session runs through the loop as any other: its opening holds the model, its settings and the
 * system prompt; each input is the user's, through the CLI; the conversation is every turn of it.
 * With `--output-format json` the answer comes with the session's figures; with `stream-json` each
 * fact is printed as it is recorded, then the result.
 *
 * Calling it from an agent's shell tool, use `-p` with the prompt as an argument: without `-p` the
 * REPL waits for input, and without a prompt `-p` reads it from stdin to its end. `bun --silent
 * cli` keeps bun's echo of the script off stdout.
 */

import { AnthropicClient } from "@effect/ai-anthropic";
import { OpenAiClient } from "@effect/ai-openai";
import { OpenAiClient as OpenAiCompatClient } from "@effect/ai-openai-compat";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Fiber, Layer, Logger, Option, PubSub, Redacted, Ref, Schema, Stdio, Stream } from "effect";
import { Argument, CliError, Command, Flag, Prompt } from "effect/cli";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { AgentContextAssembler, WholeConversation } from "../../agent-context/assembler.ts";
import { Notices } from "../../agent-context/assemble.ts";
import { Fact } from "../../agent-machine/fact.ts";
import { InputText, ModelName, ProviderName, SessionId, type TurnId, Via } from "../../agent-machine/names.ts";
import { Effort, type ModelSettings, ThinkingMode } from "../../agent-machine/settings.ts";
import { contextGauge } from "../../agent-session/accounting.ts";
import { type ProviderRequest, ToolRunner } from "../../agent-session/contracts.ts";
import { openSession, type Session } from "../../agent-session/loop.ts";
import { FallbackModelClient } from "../../agent-session/model-fallback.ts";
import { ModelFromFacts } from "../../agent-session/model-choice.ts";
import { reportedBy } from "../../agent-session/origin.ts";
import { anthropicRequests } from "../../agent-session/providers/anthropic-client.ts";
import { openAiRequests } from "../../agent-session/providers/openai-client.ts";
import { openAiCompatRequests } from "../../agent-session/providers/openai-compat-client.ts";
import { xAiClient, xAiRequests } from "../../agent-session/providers/xai-client.ts";
import { openedWith } from "../../agent-session/session-setup.ts";
import { CountingTurns, NoTurnEndHooks } from "../../agent-session/turns.ts";
import models from "./models.json" with { type: "json" };

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
  model: text("model", "A model in models.json, or provider/model"),
  effort: choice("effort", Effort.literals, "Reasoning effort; a model that does not take it is sent the nearest it does"),
  thinking: choice("thinking", ThinkingMode.literals, "When the model thinks"),
  systemPrompt: text("system-prompt", "The system prompt"),
  systemPromptFile: text("system-prompt-file", "A file holding the system prompt"),
  appendSystemPrompt: text("append-system-prompt", "Text added after the system prompt"),
  appendSystemPromptFile: text("append-system-prompt-file", "A file whose text is added after the system prompt"),
  outputFormat: choice("output-format", ["text", "json", "stream-json"], "How the answer is printed (print mode)"),
  verbose: toggle("verbose", "Print the session's facts as they are recorded"),
  // Not built yet:
  // continue: toggle("continue", "Continue the latest conversation", "c"),
  // resume: text("resume", "Resume a session", "r"),
  // sessionId: text("session-id", "The session's id"),
  // name: text("name", "Session display name", "n"),
  // forkSession: toggle("fork-session", "Fork the continued or resumed session"),
  // fallbackModel: text("fallback-model", "Comma-separated fallback models"),
  // maxTurns: positive("max-turns", true),
  // maxBudgetUsd: positive("max-budget-usd"),
  // autocompact: text("autocompact", "Auto-compact window: auto, a token count or a percentage"),
  // tools: list("tools", "Tool names, default, or an empty string"),
  // allowedTools: list("allowedTools", "Tool permission allow rules", "allowed-tools"),
  // disallowedTools: list("disallowedTools", "Tool permission deny rules", "disallowed-tools"),
  // permissionMode: choice("permission-mode", [...], "Initial permission mode"),
  // permissionPromptTool: text("permission-prompt-tool", "MCP permission handler (print mode)"),
  // mcpConfig: list("mcp-config", "MCP configuration JSON or file paths"),
  // strictMcpConfig: toggle("strict-mcp-config", "Use only the MCP configurations given"),
  // settings: text("settings", "Settings JSON or file path"),
  // settingSources: text("setting-sources", "Comma-separated settings sources: user,project,local"),
  // addDir: list("add-dir", "Additional working directories"),
  // agents: text("agents", "Custom agent definitions as JSON or a JSON file path"),
  // agent: text("agent", "Agent to use for this session"),
  // inputFormat: choice("input-format", ["text", "stream-json"], "Input encoding (print mode)"),
  // jsonSchema: text("json-schema", "Structured output schema"),
  // includePartialMessages: toggle("include-partial-messages", "Print partial stream events"),
  // noSessionPersistence: toggle("no-session-persistence", "Do not keep the session"),
  // debug: text("debug", "Enable diagnostics for categories"),
  // debugFile: text("debug-file", "Debug log destination"),
};

type Options = Command.Command.Config.Infer<typeof flags> & { readonly prompt: string | undefined };

const invalid = (message: string) => new CliError.UserError({ cause: message, userMessage: message });

/** The known models, by provider, as `models.json` lists them. */
const known: Readonly<Record<string, Readonly<Record<string, unknown>>>> = models;

/** The environment variable that holds each provider's key; a local server needs none. */
const keyVariables: Readonly<Record<string, string>> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", xai: "XAI_API_KEY" };
const keyOf = (provider: string): string | undefined => {
  const variable = keyVariables[provider];
  const key = variable === undefined ? undefined : process.env[variable];
  return key === undefined || key === "" ? undefined : key;
};

/** The provider and model `--model` names: `provider/model`, or a model `models.json` lists. */
const targetOf = (model: string | undefined) =>
  Effect.gen(function* () {
    if (model === undefined) return yield* invalid("No model: pass --model (bun cli models lists them).");
    const slash = model.indexOf("/");
    if (slash > 0 && (model.slice(0, slash) in known || model.slice(0, slash) === "localhost"))
      return { provider: ProviderName.make(model.slice(0, slash)), model: ModelName.make(model.slice(slash + 1)) };
    const provider = Object.keys(known).find((each) => model in (known[each] ?? {}));
    if (provider === undefined) return yield* invalid(`No model ${model} in models.json; name it as provider/model.`);
    return { provider: ProviderName.make(provider), model: ModelName.make(model) };
  });

/** One model client reaching every provider with a key set, and the local server. */
const clients = () => {
  const http = FetchHttpClient.layer;
  const requests: Array<Effect.Effect<readonly [ProviderName, ProviderRequest], never, never>> = [];
  const anthropic = keyOf("anthropic");
  if (anthropic !== undefined)
    requests.push(anthropicRequests().pipe(Effect.map((request) => [ProviderName.make("anthropic"), request] as const), Effect.provide(AnthropicClient.layer({ apiKey: Redacted.make(anthropic) }).pipe(Layer.provide(http)))));
  const openai = keyOf("openai");
  if (openai !== undefined)
    requests.push(openAiRequests().pipe(Effect.map((request) => [ProviderName.make("openai"), request] as const), Effect.provide(OpenAiClient.layer({ apiKey: Redacted.make(openai) }).pipe(Layer.provide(http)))));
  const xai = keyOf("xai");
  if (xai !== undefined)
    requests.push(xAiRequests().pipe(Effect.map((request) => [ProviderName.make("xai"), request] as const), Effect.provide(xAiClient(Redacted.make(xai)).pipe(Layer.provide(http)))));
  requests.push(
    openAiCompatRequests().pipe(
      Effect.map((request) => [ProviderName.make("localhost"), request] as const),
      Effect.provide(OpenAiCompatClient.layer({ apiUrl: "http://localhost:8000/v1", apiKey: Redacted.make("none") }).pipe(Layer.provide(http))),
    ),
  );
  return Layer.unwrap(Effect.all(requests).pipe(Effect.map((each) => FallbackModelClient({ requests: new Map(each), fallbacks: [] }))));
};

/** The system prompt the flags give: the prompt or its file, then the appended text or its file. */
const systemOf = (options: Options) =>
  Effect.gen(function* () {
    const read = (path: string | undefined) => (path === undefined ? Effect.undefined : Effect.promise(() => Bun.file(path).text()));
    const base = options.systemPrompt ?? (yield* read(options.systemPromptFile));
    const appended = options.appendSystemPrompt ?? (yield* read(options.appendSystemPromptFile));
    const parts = [base, appended].filter((part): part is string => part !== undefined && part !== "");
    return parts.length === 0 ? undefined : parts.join("\n\n");
  });

/** The text of the last response to `turn`. */
const answerTo = (facts: ReadonlyArray<Fact>, turn: TurnId | undefined): string =>
  facts
    .flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "ModelResponded" && fact.observation.turn === turn
        ? [fact.observation.parts.flatMap((part) => (part._tag === "Text" ? [part.text] : [])).join("")]
        : [],
    )
    .at(-1) ?? "";

const lastTurn = (facts: ReadonlyArray<Fact>): TurnId | undefined =>
  facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === "TurnStarted" ? [fact.observation.turn] : [])).at(-1);

const encodeFact = Schema.encodeSync(Fact);

/** Log lines go to stderr, so stdout holds the answer alone, as a caller parsing it expects. */
const LogsToStderr = Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]);

/** The session has no tools yet: a call names none that exists. */
const NoTools = Layer.succeed(ToolRunner, { run: () => Effect.succeed({ _tag: "Failed" as const, reason: { _tag: "NotFound" as const } }) });

/** Sends `text` to the session as the user's input, and waits until nothing is under way. */
const ask = (session: Session, text: string) =>
  session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: InputText.make(text) }).pipe(Effect.andThen(session.idle));

/** The result of a print-mode session, in the shape of Claude Code's `--output-format json`. */
const resultOf = (facts: ReadonlyArray<Fact>, sessionId: string, provider: string, model: string, started: number) => {
  const turn = lastTurn(facts);
  const ended = facts.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" && fact.decision.turn === turn ? [fact.decision.ending] : [])).at(-1);
  const gauge = contextGauge(facts, provider, model);
  const failed = ended === undefined || ended._tag === "Failed" || ended._tag === "Vetoed" || ended._tag === "Interrupted";
  return {
    type: "result",
    subtype: ended?._tag ?? "NotEnded",
    is_error: failed,
    duration_ms: Date.now() - started,
    num_turns: facts.filter((fact) => fact._tag === "Decided" && (fact.decision._tag === "AskModel" || fact.decision._tag === "TellModel")).length,
    result: ended?._tag === "Failed" ? ended.failure : answerTo(facts, turn),
    session_id: sessionId,
    model: `${provider}/${model}`,
    ...(gauge === undefined ? {} : { total_cost_usd: gauge.cost.amount, context: { used: gauge.used, size: gauge.size } }),
  };
};

export const cli = Command.make(
  "cli",
  { prompt: arg("prompt"), ...flags },
  Effect.fnUntraced(function* (options) {
    const started = Date.now();
    const stdio = yield* Stdio.Stdio;
    const interactive = yield* stdio.stdinIsTerminal;
    const target = yield* targetOf(options.model);
    const settings: ModelSettings = {
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
    };
    const system = yield* systemOf(options);
    const sessionId = crypto.randomUUID();
    // Piped input is read only when no prompt was given: a shell that leaves stdin open would
    // otherwise keep a prompted run waiting for an end of input that never comes.
    const piped = options.print && options.prompt === undefined && !interactive ? yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString) : "";

    const run = Effect.gen(function* () {
      const session = yield* openSession;
      // Facts are printed as they are recorded, in order, each once: a new fact wakes the printer,
      // which prints the session's facts from where it had got to. Before the result is printed the
      // printer is stopped and the rest are printed.
      const printed = yield* Ref.make(0);
      const printRest = Effect.gen(function* () {
        const all = yield* session.facts;
        const from = yield* Ref.getAndSet(printed, all.length);
        yield* Effect.forEach(all.slice(from), (fact) => Console.log(JSON.stringify({ type: "fact", fact: encodeFact(fact) })), { discard: true });
      });
      const following = options.verbose || options.outputFormat === "stream-json";
      const recorded = following ? yield* session.subscribe : undefined;
      const follower = recorded === undefined ? undefined : yield* Effect.forkScoped(Effect.forever(PubSub.take(recorded).pipe(Effect.andThen(printRest))));
      const catchUp = follower === undefined ? Effect.void : Fiber.interrupt(follower).pipe(Effect.andThen(printRest));
      yield* session.observe(openedWith({ session: SessionId.make(sessionId), model: { ...target, settings }, system, tools: [] }));
      yield* session.idle;
      if (options.print) {
        const prompt = [options.prompt ?? "", piped].filter((part) => part !== "").join("\n\n");
        if (prompt === "") return yield* invalid("No prompt: pass one, or pipe it in.");
        yield* ask(session, prompt);
        yield* catchUp;
        const result = resultOf(yield* session.facts, sessionId, target.provider, target.model, started);
        if (options.outputFormat === "json") yield* Console.log(JSON.stringify(result, null, 2));
        else if (options.outputFormat === "stream-json") yield* Console.log(JSON.stringify(result));
        else yield* Console.log(result.result);
        if (result.is_error) return yield* invalid(`The turn ended ${result.subtype}.`);
        return;
      }
      yield* Console.log(`${target.provider}/${target.model} · /help for commands, /exit to quit.`);
      if (options.prompt !== undefined) {
        yield* ask(session, options.prompt);
        yield* Console.log(answerTo(yield* session.facts, lastTurn(yield* session.facts)));
      }
      if (!interactive) return;
      while (true) {
        const input = yield* Prompt.String({ message: "You" });
        if (input === "/exit" || input === "/quit") break;
        if (input.trim() === "") continue;
        if (input === "/help") {
          yield* Console.log("/help  Show these commands\n/exit  Quit\nAnything else goes to the model.");
          continue;
        }
        yield* ask(session, input);
        const facts = yield* session.facts;
        yield* Console.log(answerTo(facts, lastTurn(facts)));
      }
    });

    yield* run.pipe(
      reportedBy({ _tag: "User", via: Via.make("cli") }),
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          ModelFromFacts,
          AgentContextAssembler.pipe(Layer.provide(Layer.mergeAll(WholeConversation, Layer.succeed(Notices, [])))),
          clients(),
          CountingTurns,
          NoTurnEndHooks,
          NoTools,
          LogsToStderr,
        ),
      ),
    );
  }),
).pipe(
  Command.withDescription("An agent at the command line: a REPL, or -p to ask once."),
  Command.withExamples([
    { command: 'cli -p "Hello" --model claude-sonnet-5-5', description: "Ask once and print the answer" },
    { command: 'cli -p "Hello" --model gpt-5.5 --output-format json', description: "The answer with the session's figures" },
    { command: "cli --model localhost/mlx-community/Qwen3.5-9B-8bit", description: "A REPL with a local model" },
    { command: "cli models", description: "The known models, and which providers have a key set" },
  ]),
  Command.withSubcommands([
    Command.make("models", {}, () =>
      Effect.forEach(
        Object.entries(known),
        ([provider, listed]) => Console.log(`${provider} (${keyOf(provider) === undefined ? `no ${keyVariables[provider] ?? "key"}` : "key set"}): ${Object.keys(listed).join(", ")}`),
        { discard: true },
      ),
    ).pipe(Command.withDescription("The known models, and which providers have a key set")),
  ]),
);

export const run = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.1.0" })(args);
export const main = () => run(process.argv.slice(2)).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);

if (import.meta.main) main();
