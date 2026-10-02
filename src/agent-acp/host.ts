/**
 * The ACP host: an agent of protocol v1 (`Agent.implement`) whose sessions run on the core. A
 * launcher runs `makeHost(options)` with `Agent.run` or `Agent.runStdio`.
 *
 * Per connection the host holds the sessions it made, each a draft or open:
 *
 * - `session/new` mints the id (ACP's `sessionId` and the core's `SessionId`), opens the session's
 *   world (`world.ts`), and makes a draft with the model to start with: nothing is written. Its
 *   answer carries the config options; `available_commands_update` (`/export`) follows it, once the
 *   client knows the session.
 * - `session/set_config_option` changes the draft, or, once open, is `ModelChangeArrived` from the
 *   user through ACP, taken at the next turn (agent-machine M1). The answer is every option as the
 *   configuration will be.
 * - `session/prompt` opens a draft (turn zero: its folder in the session directory, its services,
 *   `SessionOpened`) and runs the turn with `Session.prompt`. The session's feed (`feed.ts`) sends
 *   the turn's updates and asks permission; once it has taken the turn's end the host sends
 *   `usage_update` and answers with the turn's stop (`stopOf`). `/export` alone writes the
 *   transcript to `<cwd>/.labkit/exports/<sessionId>.md` without asking the model.
 * - `session/cancel` is `Session.cancel`; so is a prompt request the client cancels
 *   (`$/cancel_request`). A prompt interrupted by the end of the connection leaves its turn running
 *   in the facts, as the core allows: the host does not end it.
 * - `session/close` stops the turn under way and closes the session's scope.
 *
 * The connection's end closes every session's scope.
 */

import { isAbsolute, join } from "node:path";
import { Clock, type Context, Effect, Exit, Fiber, FileSystem, Layer, Scope, Semaphore } from "effect";
import * as Agent from "../acp/agent.ts";
import { ErrorCode, type JsonRpcError } from "../acp/json-rpc.ts";
import * as Protocol from "../acp/protocol.ts";
import type { ContentBlock, SessionConfigOption, SessionUpdate } from "../acp/schema/v1.gen.ts";
import { SessionId as AcpSessionId } from "../acp/schema/v1.gen.ts";
import { type Asked, askable, keyVariables, ModelCatalog, targetOf } from "../agent-host/catalog.ts";
import { storeFileOf } from "../agent-host/directory.ts";
import { chooseModel, defaultModel, type Draft, draftOf, opening, optionsOfDraft, saySettings, withDefaults } from "../agent-host/draft.ts";
import { markdownOf } from "../agent-host/export.ts";
import { KnownWithLocalServer, localServer, SettlingWithLocalServer } from "../agent-host/local-server.ts";
import { PermissionsFor, SessionServices } from "../agent-host/services.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { InputText, SessionId, type TurnId } from "../agent-machine/names.ts";
import type { Target, ToolRunner } from "../agent-session/contracts.ts";
import { FileBackedSessionStore } from "../agent-session/file-session-store.ts";
import { openSession, type Services, type Session } from "../agent-session/loop.ts";
import type { SessionStore } from "../agent-session/session-store.ts";
import { reportedBy } from "../agent-session/origin.ts";
import { modelOf } from "../agent-session/configuration/session-setup.ts";
import { optionsFor, type Options } from "../agent-session/configuration/options.ts";
import { KnownModels } from "../agent-session/configuration/well-known-models.ts";
import { changeOf, configOptions, InvalidChange } from "./config-options.ts";
import { acpUser, type Feed, startFeed } from "./feed.ts";
import { logKeys } from "./log-keys.ts";
import { stopOf } from "./stop-reason.ts";
import { usageUpdate } from "./usage.ts";
import { editorWorld, type World, type WorldSession, workspaceWorld } from "./world.ts";

export interface HostOptions<R = never> {
  /** The session directory's root (`agent-host/directory.ts`): each session that had a turn is a folder in it. */
  readonly directory: string;
  /**
   * Where the sessions' tools come from: `"editor"` (`editorWorld`, the default), `"local"`
   * (`workspaceWorld`, a stopgap that bypasses the editor; `LABKIT_ACP_LOCAL_TOOLS=1`), or a world
   * of the host's own.
   */
  readonly world?: "editor" | "local" | World<R> | undefined;
  /** The model sessions start with, as `provider/model` (`LABKIT_ACP_MODEL`); left out, the first the catalog lists. */
  readonly model?: string | undefined;
  /** What a session runs with, given its world's tool runner, over the session's store; `SessionServices` when left out. */
  readonly services?: ((runner: Layer.Layer<ToolRunner>) => Layer.Layer<Services, never, SessionStore>) | undefined;
}

/** The options a launcher takes from the environment: `LABKIT_ACP_MODEL` and `LABKIT_ACP_LOCAL_TOOLS`. */
export const hostOptionsFrom = (env: Readonly<Record<string, string | undefined>>): Pick<HostOptions, "model" | "world"> => ({
  model: env["LABKIT_ACP_MODEL"] === "" ? undefined : env["LABKIT_ACP_MODEL"],
  world: env["LABKIT_ACP_LOCAL_TOOLS"] === "1" ? "local" : "editor",
});

/** The command the host runs itself, without the model. */
const exportCommand = { name: "export", description: "Write this session's transcript as Markdown to .labkit/exports/<session>.md in the working folder." };

const rpcError = (code: number, message: string, data?: unknown): JsonRpcError => ({ code, message, ...(data === undefined ? {} : { data }) });

/** An open session: the core's, the services its operations run with, its scope and its feed. */
interface Opened {
  readonly session: Session;
  readonly context: Context.Context<Services>;
  readonly scope: Scope.Closeable;
  readonly feed: Feed;
}

/** A session this connection made: a draft until its first prompt, then open. */
interface Entry {
  readonly id: AcpSessionId;
  readonly cwd: string;
  readonly world: WorldSession;
  /** Held while the draft opens and while a configuration change is taken, so neither is lost. */
  readonly lock: Semaphore.Semaphore;
  state: { readonly _tag: "Draft"; readonly draft: Draft } | { readonly _tag: "Open"; readonly opened: Opened };
  /** The prompt running, if one is. */
  prompt: Fiber.Fiber<unknown, unknown> | undefined;
}

/**
 * The model the facts will ask from the next turn: the one `modelOf` gives, with each change that
 * arrived and is not taken yet (a change taken during a turn waits for a step or the turn's end).
 */
const configuredOf = (facts: ReadonlyArray<Fact>): Effect.Effect<Target> =>
  Effect.map(modelOf(facts), (now) => {
    const taken = new Set(facts.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "ModelChangeTaken" ? [fact.decision.change] : [])));
    return facts.reduce<Target>((target, fact) => {
      if (fact._tag !== "Observed" || fact.observation._tag !== "ModelChangeArrived" || taken.has(fact.seq)) return target;
      const change = fact.observation;
      const settings = { ...target.settings, ...change.settings };
      return { provider: change.provider, model: change.model, ...(Object.keys(settings).length === 0 ? {} : { settings }) };
    }, now);
  });

/** The text a prompt gives the session: its text blocks, and each resource link as a line. */
const promptText = (prompt: ReadonlyArray<ContentBlock>): string =>
  prompt
    .flatMap((block) => (block.type === "text" ? [block.text] : block.type === "resource_link" ? [`[${block.name}](${block.uri})`] : []))
    .join("\n");

/** What `session/new` says when no model can be asked. */
const noModel = `No model to ask: set ${Object.values(keyVariables).join(", ")} for a provider's models, or start the local server at ${localServer}, or name one with LABKIT_ACP_MODEL as provider/model.`;

/**
 * The ACP host as an implementation of protocol v1. It needs the model catalog (`ModelCatalog`),
 * the file system (session folders, exports) and what the world needs.
 */
export const makeHost = <R = never>(options: HostOptions<R>) => {
  const world: World<R> | World<FileSystem.FileSystem> =
    options.world === undefined || options.world === "editor" ? editorWorld : options.world === "local" ? workspaceWorld : options.world;
  const services = options.services ?? SessionServices;
  return Agent.implement<Protocol.V1Version, ModelCatalog | FileSystem.FileSystem | Scope.Scope | R>(Protocol.v1, {
    capabilities: {
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { close: {} },
    },
    handlers: (connection) =>
      Effect.gen(function* () {
        const connectionScope = yield* Scope.Scope;
        const connectionId = crypto.randomUUID().slice(0, 8);
        // What is known of each model, and how its settings apply: the local server asked once per connection.
        const known = yield* Layer.buildWithScope(Layer.mergeAll(KnownWithLocalServer, SettlingWithLocalServer), connectionScope);
        const entries = new Map<string, Entry>();

        const traced = <A, E, X>(effect: Effect.Effect<A, E, X>, session?: string) =>
          effect.pipe(Effect.annotateLogs({ connection: connectionId, ...(session === undefined ? {} : { session }) }));

        const entryOf = (sessionId: string): Effect.Effect<Entry, JsonRpcError> => {
          const entry = entries.get(sessionId);
          if (entry !== undefined) return Effect.succeed(entry);
          return Effect.logWarning(logKeys.session.unknown, { sessionId }).pipe(
            Effect.andThen(Effect.fail(rpcError(ErrorCode.ResourceNotFound, `Session ${sessionId} not found on this connection`, { sessionId }))),
          );
        };

        const send = (sessionId: AcpSessionId, update: SessionUpdate) =>
          connection
            .notify("session/update", { sessionId, update })
            .pipe(Effect.catch((error) => Effect.logWarning(logKeys.update.notSent, { kind: update.sessionUpdate, cause: error.message })));

        const capabilitiesOf = (target: { readonly provider: Asked["provider"]; readonly model: Asked["model"] }) =>
          Effect.gen(function* () {
            return yield* (yield* KnownModels)(target.provider, target.model);
          }).pipe(Effect.provideContext(known));

        /** The configuration of the session as it will be from the next turn, with what a change is taken against. */
        const configurationOf = (entry: Entry) =>
          Effect.gen(function* () {
            const configured: Options =
              entry.state._tag === "Draft"
                ? yield* optionsOfDraft(entry.state.draft)
                : yield* Effect.flatMap(Effect.flatMap(entry.state.opened.session.facts, configuredOf), optionsFor);
            const models = yield* askable;
            const limit = (yield* capabilitiesOf(configured))?.output;
            return { configured, models, limit, options: configOptions(configured, models, limit) as ReadonlyArray<SessionConfigOption> };
          }).pipe(Effect.provideContext(known));

        /** The model `session/new` starts with, or why there is none. */
        const startingModel: Effect.Effect<Asked, JsonRpcError, ModelCatalog> =
          options.model === undefined
            ? Effect.filterOrFail(defaultModel, (model): model is Asked => model !== undefined, () => rpcError(ErrorCode.InternalError, noModel))
            : targetOf(options.model).pipe(
                Effect.mapError((error) => {
                  switch (error._tag) {
                    case "ModelNotFound":
                      return rpcError(
                        ErrorCode.InternalError,
                        `LABKIT_ACP_MODEL names ${error.name}, which no source has${error.close.length === 0 ? "" : `; close: ${error.close.join(", ")}`}.`,
                      );
                    case "KeyNotSet":
                      return rpcError(ErrorCode.InternalError, `LABKIT_ACP_MODEL names a model of ${error.provider}: set ${error.variable}.`);
                    case "SourceNotAnswering":
                      return rpcError(ErrorCode.InternalError, `LABKIT_ACP_MODEL names a model of ${error.provider}, whose server at ${error.at ?? "?"} does not answer.`);
                  }
                }),
              );

        /** Opens the entry's draft: its folder, its services in a scope of its own, its feed, then `SessionOpened`. Turn zero. */
        const open = (entry: Entry, draft: Draft) =>
          Effect.gen(function* () {
            const scope = yield* Scope.fork(connectionScope);
            return yield* Effect.gen(function* () {
              const file = storeFileOf(options.directory, entry.id);
              const layer = Layer.mergeAll(services(entry.world.runner), PermissionsFor("default", true)).pipe(Layer.provideMerge(FileBackedSessionStore(file)));
              const context = yield* Layer.buildWithScope(layer, scope);
              const session = yield* openSession.pipe(Effect.provideContext(context), Scope.provide(scope));
              const feed = yield* startFeed({
                sessionId: entry.id,
                session,
                context,
                present: entry.world.present,
                connection,
                annotations: { connection: connectionId, session: entry.id },
              }).pipe(Scope.provide(scope));
              yield* session.observe(opening(draft, SessionId.make(entry.id))).pipe(Effect.provideContext(context), reportedBy(acpUser));
              yield* Effect.logInfo(logKeys.session.opened, { file, model: `${draft.model.provider}/${draft.model.model}` });
              return { session, context, scope, feed } satisfies Opened;
            }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
          }).pipe(
            Effect.catch((error) =>
              Effect.logError(logKeys.session.notOpened, { doing: "opening the draft at its first prompt", cause: error.message }).pipe(
                Effect.andThen(Effect.fail(rpcError(ErrorCode.InternalError, `The session could not be opened: ${error.message}`))),
              ),
            ),
          );

        /** `/export`: the transcript to `<cwd>/.labkit/exports/<id>.md`, said in a message. */
        const exportOf = (entry: Entry) =>
          Effect.gen(function* () {
            const say = (text: string) => send(entry.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
            if (entry.state._tag === "Draft") {
              yield* say("Nothing to export: this session has had no turn yet.");
              return { stopReason: "end_turn" as const };
            }
            const path = join(entry.cwd, ".labkit", "exports", `${entry.id}.md`);
            const markdown = markdownOf(yield* entry.state.opened.session.facts);
            const fs = yield* FileSystem.FileSystem;
            yield* fs.makeDirectory(join(entry.cwd, ".labkit", "exports"), { recursive: true }).pipe(
              Effect.andThen(fs.writeFileString(path, markdown)),
              Effect.catch((error) =>
                Effect.logError(logKeys.export.failed, { path, doing: "writing the transcript", cause: error.message }).pipe(
                  Effect.andThen(Effect.fail(rpcError(ErrorCode.InternalError, `The transcript could not be written to ${path}: ${error.message}`))),
                ),
              ),
            );
            yield* Effect.logInfo(logKeys.export.written, { path, bytes: Buffer.byteLength(markdown) });
            yield* say(`Exported this session to ${path}`);
            return { stopReason: "end_turn" as const };
          });

        /** Records the turn's interruption, and logs it, as a client's `session/cancel` does. */
        const cancelTurn = (entry: Entry, by: string) =>
          Effect.gen(function* () {
            if (entry.state._tag === "Draft") return;
            const { session, context } = entry.state.opened;
            const turn = yield* session.turn;
            yield* Effect.logInfo(logKeys.cancel.requested, { by, ...(turn === undefined ? { underWay: false } : { turn }) });
            yield* session.cancel.pipe(Effect.provideContext(context), reportedBy(acpUser));
          }).pipe(
            Effect.catchTag("SessionStoreFailed", (error) =>
              Effect.logError(logKeys.prompt.failed, { doing: "recording the turn's interruption", cause: error.message }),
            ),
          );

        /** Opens the draft if it is one, runs the turn, waits for the feed to take its end, sends the usage and gives the stop. */
        const turnOf = (entry: Entry, text: string) =>
          Effect.gen(function* () {
            const began = yield* Clock.currentTimeMillis;
            const opened = yield* entry.lock.withPermit(
              Effect.gen(function* () {
                if (entry.state._tag === "Open") return entry.state.opened;
                const made = yield* open(entry, entry.state.draft);
                entry.state = { _tag: "Open", opened: made };
                return made;
              }),
            );
            const { session, context, feed } = opened;
            yield* Effect.logInfo(logKeys.prompt.admitted, { characters: text.length });
            yield* session.prompt({ text: InputText.make(text) }).pipe(
              Effect.provideContext(context),
              reportedBy(acpUser),
              Effect.catchTag("SessionStoreFailed", (error) =>
                Effect.logError(logKeys.prompt.failed, { doing: "recording the turn", cause: error.message }).pipe(
                  Effect.andThen(Effect.fail(rpcError(ErrorCode.InternalError, `The session's facts could not be written: ${error.message}`))),
                ),
              ),
            );
            const facts = yield* session.facts;
            // The prompt returns at its turn's end, and no other turn starts meanwhile: one prompt runs at a time.
            const turn = facts.reduce<TurnId | undefined>((last, fact) => (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" ? fact.decision.turn : last), undefined);
            if (turn === undefined) return yield* Effect.die(new Error("A prompt returned with no turn ended"));
            yield* feed.turnEnded(turn);
            const usage = yield* usageUpdate(facts).pipe(Effect.provideContext(context));
            if (usage !== undefined) {
              yield* send(entry.id, usage);
              yield* Effect.logDebug(logKeys.usage.sent, { used: usage.used, size: usage.size });
            }
            const stop = stopOf(facts, turn);
            const took = (yield* Clock.currentTimeMillis) - began;
            if (stop === undefined) return yield* Effect.die(new Error(`Turn ${turn} has no stop though it ended`));
            if ("error" in stop) {
              yield* Effect.logWarning(logKeys.prompt.settled, { error: stop.error.message, code: stop.error.code, ms: took }).pipe(Effect.annotateLogs({ turn }));
              return yield* Effect.fail(stop.error);
            }
            yield* Effect.logInfo(logKeys.prompt.settled, { stopReason: stop.stopReason, ms: took }).pipe(Effect.annotateLogs({ turn }));
            return { stopReason: stop.stopReason };
          });

        const handlers: Agent.AgentHandlers<Protocol.V1Version, ModelCatalog | FileSystem.FileSystem | Scope.Scope | R> = {
          "session/new": ({ cwd, mcpServers }) =>
            traced(
              Effect.gen(function* () {
                if (!isAbsolute(cwd)) {
                  yield* Effect.logWarning(logKeys.session.refused, { cwd, cause: "the working folder is not an absolute path" });
                  return yield* Effect.fail(rpcError(ErrorCode.InvalidParams, `cwd must be an absolute path: ${cwd}`));
                }
                const model = yield* startingModel.pipe(
                  Effect.tapError((error) => Effect.logWarning(logKeys.session.refused, { cwd, cause: error.message })),
                );
                const id = AcpSessionId.make(crypto.randomUUID());
                const opened = yield* (world as World<R | FileSystem.FileSystem>).open({ sessionId: id, cwd, mcpServers, connection });
                const capabilities = yield* capabilitiesOf(model);
                const draft = withDefaults(
                  draftOf({ model, tools: opened.tools, ...(opened.system === undefined ? {} : { system: opened.system }) }),
                  capabilities,
                );
                const entry: Entry = { id, cwd, world: opened, lock: yield* Semaphore.make(1), state: { _tag: "Draft", draft }, prompt: undefined };
                entries.set(id, entry);
                const { options: configured } = yield* configurationOf(entry);
                yield* Effect.logInfo(logKeys.session.created, {
                  cwd,
                  model: `${model.provider}/${model.model}`,
                  tools: opened.tools.map((tool) => tool.name),
                  mcpServers: mcpServers.length,
                }).pipe(Effect.annotateLogs({ session: id }));
                // The update follows the response: the response is written before this handler's fiber ends.
                const self = yield* Effect.fiber;
                yield* Effect.forkIn(
                  Fiber.await(self).pipe(
                    Effect.andThen(send(id, { sessionUpdate: "available_commands_update", availableCommands: [exportCommand] })),
                    Effect.annotateLogs({ session: id }),
                  ),
                  connectionScope,
                );
                return { sessionId: id, configOptions: configured };
              }),
            ),

          "session/set_config_option": (params) =>
            traced(
              Effect.gen(function* () {
                const entry = yield* entryOf(params.sessionId);
                const { configId } = params;
                return yield* entry.lock.withPermit(
                  Effect.gen(function* () {
                    const now = yield* configurationOf(entry);
                    const change =
                      typeof params.value === "string"
                        ? changeOf(configId, params.value, now.configured, now.models, now.limit)
                        : new InvalidChange({ reason: `Option ${configId} takes a value of a select, not ${JSON.stringify(params.value)}.` });
                    if (change instanceof InvalidChange) {
                      yield* Effect.logWarning(logKeys.config.refused, { configId, value: params.value, cause: change.reason });
                      return yield* Effect.fail(rpcError(ErrorCode.InvalidParams, change.reason, { configId }));
                    }
                    if (entry.state._tag === "Draft") {
                      const draft = entry.state.draft;
                      const moved =
                        change.provider === draft.model.provider && change.model === draft.model.model
                          ? draft
                          : chooseModel(draft, { provider: change.provider, model: change.model });
                      entry.state = { _tag: "Draft", draft: change.settings === undefined ? moved : saySettings(moved, change.settings) };
                    } else {
                      const { session, context } = entry.state.opened;
                      yield* session.observe({ _tag: "ModelChangeArrived", ...change }).pipe(
                        Effect.provideContext(context),
                        reportedBy(acpUser),
                        Effect.catchTag("SessionStoreFailed", (error) =>
                          Effect.logError(logKeys.config.refused, { configId, doing: "recording the change", cause: error.message }).pipe(
                            Effect.andThen(Effect.fail(rpcError(ErrorCode.InternalError, `The change could not be recorded: ${error.message}`))),
                          ),
                        ),
                      );
                    }
                    yield* Effect.logInfo(logKeys.config.changed, {
                      configId,
                      value: params.value,
                      applies: entry.state._tag === "Draft" ? "to the draft" : "from the next turn",
                    });
                    return { configOptions: (yield* configurationOf(entry)).options };
                  }),
                );
              }),
              params.sessionId,
            ),

          "session/prompt": ({ sessionId, prompt }) =>
            traced(
              Effect.gen(function* () {
                const entry = yield* entryOf(sessionId);
                const text = promptText(prompt);
                yield* Effect.logInfo(logKeys.prompt.received, { blocks: prompt.map((block) => block.type), characters: text.length });
                if (entry.prompt !== undefined) {
                  yield* Effect.logWarning(logKeys.prompt.refused, { cause: "a prompt is running" });
                  return yield* Effect.fail(rpcError(-32000, `Session ${sessionId} already has an active prompt`));
                }
                const self = yield* Effect.fiber;
                entry.prompt = self;
                const run =
                  prompt.length === 1 && text.trim() === "/export"
                    ? exportOf(entry)
                    : turnOf(entry, text).pipe(
                        Effect.onInterrupt(() =>
                          Effect.flatMap(connection.open, (open) =>
                            open
                              ? Effect.logInfo(logKeys.prompt.interrupted, { by: "the client", turn: "cancelled" }).pipe(Effect.andThen(cancelTurn(entry, "$/cancel_request")))
                              : Effect.logInfo(logKeys.prompt.interrupted, { by: "the end of the connection", turn: "left running" }),
                          ),
                        ),
                      );
                return yield* run.pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      entry.prompt = undefined;
                    }),
                  ),
                );
              }),
              sessionId,
            ),

          "session/cancel": ({ sessionId }) =>
            traced(
              Effect.gen(function* () {
                const entry = entries.get(sessionId);
                if (entry === undefined) return yield* Effect.logWarning(logKeys.session.unknown, { sessionId, doing: "session/cancel" });
                yield* cancelTurn(entry, "session/cancel");
              }),
              sessionId,
            ),

          "session/close": ({ sessionId }) =>
            traced(
              Effect.gen(function* () {
                const entry = yield* entryOf(sessionId);
                entries.delete(sessionId);
                if (entry.state._tag === "Open") {
                  yield* cancelTurn(entry, "session/close");
                  if (entry.prompt !== undefined) yield* Fiber.await(entry.prompt);
                  yield* Scope.close(entry.state.opened.scope, Exit.void);
                }
                yield* Effect.logInfo(logKeys.session.closed, { was: entry.state._tag === "Open" ? "open" : "a draft" });
                return {};
              }),
              sessionId,
            ),
        };
        return handlers;
      }),
  });
};
