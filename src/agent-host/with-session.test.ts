/**
 * A session as a host runs it (`withSession`): what runs inside the session reads the session's
 * context, and what an open records of the session's working folder reaches the model.
 */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { AgentContextAssembler, WholeConversation } from "../agent-context/assembler.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { BoringContextAssembler, BoringModelProvider } from "../../tests/support/boring.ts";
import { runTest } from "../../tests/support/run.ts";
import { testSessionId } from "../../tests/support/session-context.ts";
import { test, testFolder } from "../../tests/support/test.ts";
import { plugin } from "../agent-config/plugin.ts";
import { seamLayer, seamListsOf } from "../agent-config/seams.ts";
import { SessionContext } from "../agent-environment/session-context.ts";
import { CallId, InputText, ModelName, ModelText, ProviderName, SessionId, StopReason, ToolName } from "../agent-machine/names.ts";
import type { Policy } from "../agent-policy/policy.ts";
import { ModelClient, type ModelContext } from "../agent-session/contracts.ts";
import { asText, receivedJson, receivedText } from "../agent-session/received.ts";
import { SourcedToolRunner, type ToolSource } from "../agent-session/tool-sources.ts";
import { CountingTurnsInStore } from "../agent-session/turns.ts";
import { makeSessionContext } from "./session-context.ts";
import { Headless, withSession } from "./with-session.ts";

/** A model that calls `attribute` once, then answers. */
const scripted = () => {
  let asked = 0;
  return Layer.succeed(ModelClient, {
    respond: (target, _context, turn) =>
      Effect.sync(() => ({
        _tag: "ModelResponded" as const,
        turn,
        provider: target.provider,
        model: target.model,
        parts:
          ++asked === 1
            ? [{ _tag: "ToolCall" as const, call: CallId.make("call-1"), tool: ToolName.make("attribute"), input: receivedJson({}) }]
            : [{ _tag: "Text" as const, text: ModelText.make("Done.") }],
        stop: StopReason.make("stop"),
        ending: { _tag: "Complete" as const },
        metadata: receivedJson({}),
      })),
  });
};

test("inside a session, a tool and a plug-in's tool call policy read the session's id from its context, in the fibers the loop runs requests in", async () => {
  const seen: Array<{ readonly by: "tool" | "policy"; readonly session: string; readonly fiber: number }> = [];
  // A source built before the session, as a host builds its tools: it reads the context when a call runs.
  const attributing: ToolSource = {
    tools: [{ name: ToolName.make("attribute"), description: "Says which session it runs in.", input: { type: "object" }, kind: "read", replay: "safe" }],
    run: () =>
      Effect.gen(function* () {
        const { session } = yield* SessionContext;
        seen.push({ by: "tool", session, fiber: yield* Effect.fiberId });
        return { _tag: "Succeeded", output: receivedText(session) };
      }),
  };
  // A plug-in's policy, listed by a configuration and made from what the host provides (`FromHost`), which lets every call run.
  const attribution = plugin("attribution", Schema.Struct({}), ["toolCalls"], () => ({
    toolCalls: () =>
      Effect.gen(function* () {
        const { session } = yield* SessionContext;
        seen.push({ by: "policy", session, fiber: yield* Effect.fiberId });
        return {
          start: () => ({ _tag: "Decided", verdict: { _tag: "Continue" } }),
          receive: () => ({ _tag: "Decided", verdict: { _tag: "Continue" } }),
        } satisfies Policy<unknown>;
      }),
  }));
  const configuration = { lists: { toolCalls: [{ name: "attribution", plugin: attribution, settings: {} }] }, mcpServers: [], models: new Map(), cli: { view: { thinking: "on" as const } } };
  const { toolSources: _, commandEnvironment: __, ...lists } = seamListsOf(configuration, { canAsk: false });
  const ran = await runTest(
    Effect.flatMap(makeSessionContext({ session: SessionId.make("attributed"), working: testFolder(), given: [] }), (context) =>
      withSession(
        {
          context,
          target: { provider: ProviderName.make("boring"), model: ModelName.make("boring-1") },
          settings: {},
          persist: false,
          root: testFolder(),
          record: { host: "test" },
          services: Layer.mergeAll(BoringModelProvider, BoringContextAssembler, scripted(), CountingTurnsInStore, SourcedToolRunner, seamLayer(lists)),
          boltOns: [{ sources: [attributing] }],
          logs: Layer.empty,
          host: Headless,
        },
        (session) =>
          Effect.gen(function* () {
            const ending = yield* session.prompt({ text: InputText.make("Which session is this?") });
            const outputs = (yield* session.facts).flatMap((fact) =>
              fact._tag === "Observed" && fact.observation._tag === "ToolEnded" && fact.observation.outcome._tag === "Succeeded" ? [asText(fact.observation.outcome.output)] : [],
            );
            return { ending: ending._tag, outputs, fiber: yield* Effect.fiberId };
          }),
      ),
    ).pipe(Effect.provide(BunServices.layer)),
  );
  expect(ran.ending).toBe("Completed");
  expect(ran.outputs).toEqual(["attributed"]);
  // The session's own context, not the one the test runs in.
  expect(seen.map(({ by, session }) => ({ by, session }))).toEqual([
    { by: "policy", session: "attributed" },
    { by: "tool", session: "attributed" },
  ]);
  expect(seen.some((each) => each.session === testSessionId)).toBe(false);
  // Each ran in a fiber the loop started for the request, not in the fiber that gave the prompt.
  expect(seen.every((each) => each.fiber !== ran.fiber)).toBe(true);
});

/** A model that answers every request, and keeps what each request was sent. */
const recording = (sent: Array<ModelContext>) =>
  Layer.succeed(ModelClient, {
    respond: (target, context, turn) =>
      Effect.sync(() => {
        sent.push(context);
        return {
          _tag: "ModelResponded" as const,
          turn,
          provider: target.provider,
          model: target.model,
          parts: [{ _tag: "Text" as const, text: ModelText.make("Done.") }],
          stop: StopReason.make("stop"),
          ending: { _tag: "Complete" as const },
          metadata: receivedJson({}),
        };
      }),
  });

/** Opens the session `rehomed` in memory in the working folder `working`, continuing `continues` when given; prompts it when `prompt` is given. Returns its facts. */
const openIn = (working: string, sent: Array<ModelContext>, continues?: ReadonlyArray<Fact>, prompt?: string) =>
  runTest(
    Effect.flatMap(makeSessionContext({ session: SessionId.make("rehomed"), working, given: [] }), (context) =>
      withSession(
        {
          context,
          target: { provider: ProviderName.make("boring"), model: ModelName.make("boring-1") },
          settings: {},
          ...(continues === undefined ? {} : { continues }),
          persist: false,
          root: testFolder(),
          record: { host: "test" },
          services: Layer.mergeAll(BoringModelProvider, AgentContextAssembler.pipe(Layer.provide(WholeConversation)), recording(sent), CountingTurnsInStore, SourcedToolRunner),
          boltOns: [],
          logs: Layer.empty,
          host: Headless,
        },
        (session) => Effect.andThen(prompt === undefined ? Effect.void : session.prompt({ text: InputText.make(prompt) }), session.facts),
      ),
    ).pipe(Effect.provide(BunServices.layer)),
  );

test("a session reopened in another working folder before its first turn records SessionHomed: the system prompt names the new folder, and no message tells of a move", async () => {
  const first = join(testFolder(), "first");
  const second = join(testFolder(), "second");
  const sent: Array<ModelContext> = [];
  const opened = await openIn(first, sent);
  const facts = await openIn(second, sent, opened, "Where are you?");
  const homed = facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === "SessionHomed" ? [fact.observation.working] : []));
  expect(homed as ReadonlyArray<string>).toEqual([first, second]);
  expect(sent.map((context) => context.system)).toEqual([`The working folder is ${second}.`]);
  expect(JSON.stringify(sent[0]?.messages)).not.toContain(first);
});
