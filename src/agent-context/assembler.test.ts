/**
 * The loop's context assembler: the system prompt the session opened with, and notices last, as one
 * instruction message after the conversation; each notice recorded, and carried in its place by
 * the requests after it.
 */

import { afterAll, expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { Notices, type NoticeProvider } from "./assemble.ts";
import { AgentContextAssembler, WholeConversation } from "./assembler.ts";
import { SystemTimeNoticeProvider } from "./example-providers.ts";
import { TurnId } from "../agent-machine/names.ts";
import type { Observation } from "../agent-machine/observation.ts";
import { ContextAssembler } from "../agent-session/contracts.ts";
import { openSession } from "../agent-session/loop.ts";
import { EphemeralSessionStore } from "../agent-session/session-store.ts";
import { AnthropicModelClient } from "../agent-session/providers/anthropic-client.ts";
import { Report } from "../agent-session/report.ts";
import { CountingTurns, NoTurnEndHooks } from "../agent-session/turns.ts";
import { BoringModelProvider, boringOpening } from "../../tests/support/boring.ts";
import { observe, open, opened } from "../../tests/support/drive.ts";
import { anthropicAt } from "../../tests/support/providers.ts";
import { anthropicStream } from "../../tests/support/streams.ts";
import { runTest } from "../../tests/support/run.ts";
import { SmolToolRunner, smolCatalog } from "../../tests/support/smol-tools.ts";

test("A4: the notices are sent last, as an instruction after the latest input, and each is reported", async () => {
  const session = open();
  const system = { mediaType: "text/plain", body: { _tag: "Text", text: "You are a helpful assistant." } };
  observe(session, { ...opened, system });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "What day is it?" });
  const reported: Array<Observation> = [];
  const assembled = await runTest(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-29T12:00:00.000Z"));
      return yield* (yield* ContextAssembler).assemble(session.journal, TurnId.make("turn-1"));
    }).pipe(
      Effect.provideService(Report, (observation) => Effect.sync(() => void reported.push(observation))),
      Effect.provide(
        Layer.mergeAll(
          AgentContextAssembler.pipe(
            Layer.provide(
              Layer.mergeAll(WholeConversation, Layer.succeed(Notices, [SystemTimeNoticeProvider])),
            ),
          ),
          TestClock.layer(),
        ),
      ),
    ),
  );
  const notice = "The current time is 2026-09-29T12:00:00.000Z.";
  expect(assembled.system).toBe("You are a helpful assistant.");
  expect(assembled.messages).toEqual([
    { role: "user", parts: [{ _tag: "Text", text: "What day is it?" }] },
    { role: "instruction", parts: [{ _tag: "Text", text: notice }] },
  ]);
  expect(reported as unknown).toEqual([{ _tag: "NoticeInserted", turn: "turn-1", text: notice }]);
});

const stops: Array<() => unknown> = [];
afterAll(() => {
  for (const stop of stops) stop();
});

test("S5 A4: a later request carries each earlier notice where it was sent, and a new one at the end", async () => {
  const bodies: Array<{ messages: ReadonlyArray<unknown> }> = [];
  const responses = [
    { content: [{ type: "tool_use", id: "toolu_1", name: "add", input: { a: 2, b: 3 } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "5." }], stop_reason: "end_turn" },
  ];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push((await request.json()) as (typeof bodies)[number]);
      return anthropicStream(responses[bodies.length - 1]);
    },
  });
  stops.push(() => server.stop(true));
  let sent = 0;
  const counted: NoticeProvider = { notices: Effect.sync(() => [`Notice ${++sent}.`]) };
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(boringOpening(smolCatalog));
      yield* session.idle;
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "What is 2 + 3?" } as unknown as Observation);
      yield* session.idle;
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BoringModelProvider,
          AgentContextAssembler.pipe(Layer.provide(Layer.mergeAll(WholeConversation, Layer.succeed(Notices, [counted])))),
          AnthropicModelClient.pipe(Layer.provide(anthropicAt(new URL("/v1/messages", server.url)))),
          CountingTurns,
          NoTurnEndHooks,
          SmolToolRunner,
        ),
      ),
    ),
  );
  const question = { role: "user", content: [{ type: "text", text: "What is 2 + 3?" }] };
  const notice = (n: number) => ({ role: "system", content: [{ type: "text", text: `Notice ${n}.` }] });
  expect(bodies.map((body) => body.messages)).toEqual([
    [question, notice(1)],
    [
      question,
      notice(1),
      { role: "assistant", content: [responses[0]?.content[0]] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "5" }] },
      notice(2),
    ],
  ]);
  const inserted = facts.flatMap((fact) =>
    fact._tag === "Observed" && fact.observation._tag === "NoticeInserted" ? [fact.observation.text] : [],
  );
  expect(inserted as unknown).toEqual(["Notice 1.", "Notice 2."]);
  expect(facts.some((fact) => fact._tag === "Decided" && fact.decision._tag === "ObservationNotExpected")).toBe(false);
});
