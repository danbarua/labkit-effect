/**
 * The session store, against files in a folder made for each test: every fact recorded is written
 * once, in order, and reads back as it was; one process writes a session at a time; a write that
 * fails stops the session; a line whose write did not finish is cut off; and a session that goes
 * on from its file sends what it would have sent had it not stopped.
 */

import { expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer, PubSub, Schema } from "effect";
import { AgentContextAssembler, WholeConversation } from "../../agent-context/assembler.ts";
import { Notices } from "../../agent-context/assemble.ts";
import { Fact } from "../../agent-machine/fact.ts";
import { CallId, InputText, ModelText, StopReason, ToolName } from "../../agent-machine/names.ts";
import type { Observation } from "../../agent-machine/observation.ts";
import { answerPicking, OptionId, permissions } from "../../agent-policy/permissions.ts";
import type { Policy } from "../../agent-policy/policy.ts";
import { ModelClient, type ModelContext, ToolCallPolicy } from "../../agent-session/contracts.ts";
import { endTurnLeftRunning, type Session, sessionFrom } from "../../agent-session/loop.ts";
import { receivedJson } from "../../agent-session/received.ts";
import { countingTurnsAfter, NoTurnEndHooks } from "../../agent-session/turns.ts";
import { BoringModelProvider, boringOpening } from "../../../tests/support/boring.ts";
import { runTest } from "../../../tests/support/run.ts";
import { smolCatalog, SmolToolRunner } from "../../../tests/support/smol-tools.ts";
import { test } from "../../../tests/support/test.ts";
import { journal, readFacts } from "./store.ts";

const folder = () => mkdtempSync(join(tmpdir(), "store-"));
const line = Schema.encodeSync(Schema.fromJsonString(Fact));

/** A model that calls `echo` when asked to, and otherwise answers "ok"; every context it is sent is kept. */
const scripted = (sent: Array<ModelContext>) =>
  Layer.succeed(ModelClient, {
    respond: (target, context, turn) =>
      Effect.sync(() => {
        sent.push(context);
        const last = context.messages.at(-1)?.parts.at(-1);
        const asked = last?._tag === "Text" && last.text.startsWith("echo");
        return {
          _tag: "ModelResponded" as const,
          turn,
          provider: target.provider,
          model: target.model,
          parts: asked
            ? [{ _tag: "ToolCall" as const, call: CallId.make(`c-${turn}`), tool: ToolName.make("echo"), input: receivedJson({ text: "hi" }) }]
            : [{ _tag: "Text" as const, text: ModelText.make("ok") }],
          stop: StopReason.make("end_turn"),
          ending: { _tag: "Complete" as const },
          metadata: receivedJson({}),
        };
      }),
  });

/** The services a session runs with here; its turns count on from `turns`. `echo` asks for permission, which is given. */
const services = (sent: Array<ModelContext>, turns = 0) =>
  Layer.mergeAll(
    BunServices.layer,
    BoringModelProvider,
    AgentContextAssembler.pipe(Layer.provide(Layer.mergeAll(WholeConversation, Layer.succeed(Notices, [])))),
    scripted(sent),
    SmolToolRunner,
    countingTurnsAfter(turns),
    NoTurnEndHooks,
    Layer.succeed(ToolCallPolicy, (facts) => Effect.succeed(permissions("default", true, () => "other", facts) as Policy<unknown>)),
  );

/** Answers each permission question with "allow once", for as long as the scope lasts. */
const allowing = (session: Session) =>
  Effect.gen(function* () {
    const recorded = yield* session.subscribe;
    yield* Effect.forkScoped(
      Effect.forever(
        PubSub.take(recorded).pipe(
          Effect.flatMap((fact) =>
            fact._tag === "Observed" && fact.observation._tag === "PermissionAsked"
              ? session.observe({ _tag: "PermissionAnswered", call: fact.observation.call, answer: answerPicking(OptionId.make("allow-once")) })
              : Effect.void,
          ),
        ),
      ),
    );
  });

const ask = (session: Session, text: string) =>
  session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: InputText.make(text) } as Observation).pipe(Effect.andThen(session.idle));

test("every fact recorded is written once, in order, and reads back as it was recorded", async () => {
  const file = join(folder(), "s1.jsonl");
  const { held, read } = await runTest(
    Effect.gen(function* () {
      const session = yield* sessionFrom([]);
      const store = yield* journal(session, file, "s1", []);
      yield* allowing(session);
      yield* session.observe(boringOpening(smolCatalog));
      yield* ask(session, "hello");
      yield* ask(session, "echo hi");
      yield* ask(session, "bye");
      yield* store.finish;
      return { held: yield* session.facts, read: (yield* readFacts(file)).facts };
    }).pipe(Effect.provide(services([]))),
  );
  expect(read.map((fact) => fact.seq as number)).toEqual(held.map((_, at) => at + 1));
  expect(read).toEqual(held);
  const tags = read.flatMap((fact) => (fact._tag === "Observed" ? [fact.observation._tag] : []));
  expect(tags).toContain("PermissionAsked");
  expect(tags).toContain("ToolEnded");
});

test("one process writes a session at a time; a lock left by a process that ended is taken over", async () => {
  const file = join(folder(), "s1.jsonl");
  const second = await runTest(
    Effect.gen(function* () {
      yield* journal(yield* sessionFrom([]), file, "s1", []);
      return yield* Effect.exit(journal(yield* sessionFrom([]), file, "s1", []));
    }).pipe(Effect.provide(services([]))),
  );
  expect(Exit.isFailure(second) ? String(second.cause) : "").toContain(`Session s1 is open in another process (pid ${process.pid})`);
  // The scope that held the lock has closed, and removed it.
  expect(() => readFileSync(`${file}.lock`)).toThrow();
  // A process that is not running held this one.
  writeFileSync(`${file}.lock`, "999999");
  const taken = await runTest(
    Effect.gen(function* () {
      yield* journal(yield* sessionFrom([]), file, "s1", []);
      return readFileSync(`${file}.lock`, "utf8");
    }).pipe(Effect.provide(services([]))),
  );
  expect(taken).toBe(String(process.pid));
});

test("a write that fails stops the session and says which facts are not in the file", async () => {
  const dir = folder();
  const file = join(dir, "s1.jsonl");
  const failed = await runTest(
    Effect.gen(function* () {
      const session = yield* sessionFrom([]);
      const store = yield* journal(session, file, "s1", []);
      // The file becomes a folder: the next append fails.
      mkdirSync(file);
      return yield* Effect.exit(Effect.raceFirst(session.observe(boringOpening()).pipe(Effect.andThen(Effect.never)), store.failed));
    }).pipe(Effect.provide(services([]))),
  );
  expect(Exit.isFailure(failed) ? String(failed.cause) : "").toContain(`The session's facts could not be written to ${file}`);
});

test("a last line whose write did not finish is not read, and is cut off before the file is written to again", async () => {
  const file = join(folder(), "s1.jsonl");
  const { held } = await runTest(
    Effect.gen(function* () {
      const session = yield* sessionFrom([]);
      const store = yield* journal(session, file, "s1", []);
      yield* session.observe(boringOpening());
      yield* ask(session, "hello");
      yield* store.finish;
      return { held: yield* session.facts };
    }).pipe(Effect.provide(services([]))),
  );
  const whole = readFileSync(file, "utf8");
  writeFileSync(file, `${whole}{"_tag":"Observed","seq":${held.length + 1},"ti`);
  const read = await runTest(readFacts(file).pipe(Effect.provide(BunServices.layer)));
  expect(read.facts).toEqual(held);
  expect(read.torn).toStartWith('{"_tag":"Observed"');
  const after = await runTest(
    Effect.gen(function* () {
      const session = yield* sessionFrom(held);
      const store = yield* journal(session, file, "s1", held);
      yield* ask(session, "again");
      yield* store.finish;
      return { now: yield* session.facts, read: (yield* readFacts(file)) };
    }).pipe(Effect.provide(services([], 1))),
  );
  expect(after.read.torn).toBe("");
  expect(after.read.facts).toEqual(after.now);
});

test("a file whose facts are not in order is refused", async () => {
  const file = join(folder(), "s1.jsonl");
  const held = await runTest(
    Effect.gen(function* () {
      const session = yield* sessionFrom([]);
      yield* session.observe(boringOpening());
      yield* ask(session, "hello");
      return yield* session.facts;
    }).pipe(Effect.provide(services([]))),
  );
  writeFileSync(file, [held[0], held[2], held[1]].map((fact) => `${line(fact as Fact)}\n`).join(""));
  const read = await runTest(Effect.exit(readFacts(file)).pipe(Effect.provide(BunServices.layer)));
  expect(Exit.isFailure(read) ? String(read.cause) : "").toContain("line 2 holds fact 3 where fact 2 belongs");
});

test("X4: what going on from the file records (the end of a turn left running) is written to the file too", async () => {
  const file = join(folder(), "s1.jsonl");
  // A session stopped while its model was asked: the facts end with the request made.
  const stopped = await runTest(
    Effect.gen(function* () {
      const session = yield* sessionFrom([]);
      const store = yield* journal(session, file, "s1", []);
      yield* session.observe(boringOpening());
      yield* session.idle;
      yield* store.finish;
      return yield* session.facts;
    }).pipe(Effect.provide(services([]))),
  );
  const running = [
    ...stopped,
    ...[
      { _tag: "InputArrived", from: { _tag: "User" }, text: "hello" },
      { _tag: "TurnStarted", turn: "turn-1" },
    ].map((observation, at): Fact => ({ _tag: "Observed", seq: (stopped.length + at + 1) as Fact["seq"], time: stopped[0]?.time as Fact["time"], origin: { _tag: "User", via: "test" } as Extract<Fact, { _tag: "Observed" }>["origin"], observation: observation as Observation })),
  ];
  writeFileSync(file, running.map((fact) => `${line(fact)}\n`).join(""));
  const { now, read } = await runTest(
    Effect.gen(function* () {
      const session = yield* sessionFrom(running);
      const store = yield* journal(session, file, "s1", running);
      yield* endTurnLeftRunning(session, running);
      yield* store.finish;
      return { now: yield* session.facts, read: (yield* readFacts(file)).facts };
    }).pipe(Effect.provide(services([], 1))),
  );
  expect(now.length).toBeGreaterThan(running.length);
  expect(read).toEqual(now);
  expect(read.slice(running.length).flatMap((fact) => (fact._tag === "Observed" ? [fact.observation._tag] : []))).toContain("TurnInterrupted");
});

test("A6 X4: a session that goes on from its file sends the next request it would have sent had it not stopped", async () => {
  const live: Array<ModelContext> = [];
  await runTest(
    Effect.gen(function* () {
      const session = yield* sessionFrom([]);
      yield* allowing(session);
      yield* session.observe(boringOpening(smolCatalog));
      for (const text of ["hello", "echo hi", "bye"]) yield* ask(session, text);
    }).pipe(Effect.provide(services(live))),
  );
  const file = join(folder(), "s1.jsonl");
  const before: Array<ModelContext> = [];
  const stored = await runTest(
    Effect.gen(function* () {
      const session = yield* sessionFrom([]);
      const store = yield* journal(session, file, "s1", []);
      yield* allowing(session);
      yield* session.observe(boringOpening(smolCatalog));
      for (const text of ["hello", "echo hi"]) yield* ask(session, text);
      yield* store.finish;
      return (yield* readFacts(file)).facts;
    }).pipe(Effect.provide(services(before))),
  );
  const after: Array<ModelContext> = [];
  await runTest(
    Effect.gen(function* () {
      const session = yield* sessionFrom(stored);
      const store = yield* journal(session, file, "s1", stored);
      yield* endTurnLeftRunning(session, stored);
      yield* ask(session, "bye");
      yield* store.finish;
    }).pipe(Effect.provide(services(after, 2))),
  );
  expect(after.length).toBe(1);
  expect(after[0]).toEqual(live.at(-1));
});
