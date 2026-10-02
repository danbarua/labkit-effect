/**
 * The session store, with the loop over it: each fact is written down before anything is done on
 * it; a file is read back as it was written; one process writes a file at a time; a write that
 * fails stops the session; a line whose write did not finish is cut off. Each test has a folder of
 * its own.
 */

import { expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, type FileSystem, Layer, Ref, Schema } from "effect";
import { BoringModelProvider, boringOpening, WholeSessionAssembler } from "../../tests/support/boring.ts";
import { runTest } from "../../tests/support/run.ts";
import { smolCatalog } from "../../tests/support/smol-tools.ts";
import { test } from "../../tests/support/test.ts";
import { Fact } from "../agent-machine/fact.ts";
import { CallId, InputText, ModelText, StopReason, ToolName } from "../agent-machine/names.ts";
import { ModelClient, ToolRunner } from "./contracts.ts";
import { FileBackedSessionStore, readFacts } from "./file-session-store.ts";
import { openSession, type Session } from "./loop.ts";
import { receivedJson, receivedText } from "./received.ts";
import { ephemeralSessionStore, SessionStore, SessionStoreFailed } from "./session-store.ts";
import { CountingTurnsInStore, NoTurnEndHooks } from "./turns.ts";

const fileIn = () => join(mkdtempSync(join(tmpdir(), "store-")), "s1.jsonl");
const line = Schema.encodeSync(Schema.fromJsonString(Fact));
const tagsIn = (facts: ReadonlyArray<Fact>) => facts.map((fact) => (fact._tag === "Observed" ? fact.observation._tag : fact.decision._tag));

/** A model that calls `echo` when the input starts with "echo", and otherwise answers "ok". */
const Scripted = Layer.succeed(ModelClient, {
  respond: (target, context, turn) =>
    Effect.sync(() => {
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

/** A tool runner that answers every call at once. */
const Answering = Layer.succeed(ToolRunner, { run: () => Effect.succeed({ _tag: "Succeeded" as const, output: receivedText("hi") }) });

/** The loop's services over `store`, with `model` and `tools`. */
const over = (store: Layer.Layer<SessionStore, SessionStoreFailed, FileSystem.FileSystem>, model = Scripted, tools = Answering) => {
  const kept = store.pipe(Layer.provide(BunServices.layer));
  return Layer.mergeAll(BunServices.layer, BoringModelProvider, WholeSessionAssembler, model, tools, NoTurnEndHooks, CountingTurnsInStore).pipe(Layer.provideMerge(kept));
};

const ask = (session: Session, text: string) =>
  session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: InputText.make(text) }).pipe(Effect.andThen(session.idle));

test("J2: every fact is in the file as it is recorded, once, in order, and reads back as it was", async () => {
  const file = fileIn();
  const { held, read } = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening(smolCatalog));
      for (const text of ["hello", "echo hi", "bye"]) yield* ask(session, text);
      return { held: yield* session.facts, read: (yield* readFacts(file)).facts };
    }).pipe(Effect.provide(over(FileBackedSessionStore(file)))),
  );
  expect(read.map((fact) => fact.seq as number)).toEqual(held.map((_, at) => at + 1));
  expect(read).toEqual(held);
  expect(tagsIn(read)).toContain("ToolEnded");
});

test("J2: that a request was made is in the file before it goes out: the model and the tool find it there", async () => {
  const file = fileIn();
  const seen: Array<string> = [];
  const lastLine = () => {
    const lines = readFileSync(file, "utf8").trim().split("\n");
    return JSON.parse(lines.at(-1) ?? "{}") as { observation?: { _tag?: string } };
  };
  const model = Layer.succeed(ModelClient, {
    respond: (target, context, turn) =>
      Effect.gen(function* () {
        seen.push(`model: ${lastLine().observation?._tag}`);
        return yield* (yield* ModelClient).respond(target, context, turn);
      }).pipe(Effect.provide(Scripted)),
  });
  const tools = Layer.succeed(ToolRunner, {
    run: () =>
      Effect.sync(() => {
        seen.push(`tool: ${lastLine().observation?._tag}`);
        return { _tag: "Succeeded" as const, output: receivedText("hi") };
      }),
  });
  await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening(smolCatalog));
      yield* ask(session, "echo hi");
    }).pipe(Effect.provide(over(FileBackedSessionStore(file), model, tools))),
  );
  expect(seen).toEqual(["model: ModelRequestDispatched", "tool: ToolCallDispatched", "model: ModelRequestDispatched"]);
});

test("J3: a write that fails stops the session: nothing after it is written, the tool does not run, and observe fails", async () => {
  const ran = { count: 0 };
  const tools = Layer.succeed(ToolRunner, {
    run: () => Effect.sync(() => (ran.count += 1)).pipe(Effect.as({ _tag: "Succeeded" as const, output: receivedText("hi") })),
  });
  // A store whose write of a call's dispatch fails.
  const failing = Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const kept = yield* Ref.make<ReadonlyArray<Fact>>([]);
      return {
        facts: Ref.get(kept),
        append: (more: ReadonlyArray<Fact>) =>
          more.some((fact) => fact._tag === "Observed" && fact.observation._tag === "ToolCallDispatched")
            ? Effect.fail(new SessionStoreFailed({ message: "the disk is full" }))
            : Ref.update(kept, (before) => [...before, ...more]),
      };
    }),
  );
  const { asked, after, kept } = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening(smolCatalog));
      const asked = yield* Effect.exit(ask(session, "echo hi"));
      const after = yield* Effect.exit(session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: InputText.make("more") }));
      return { asked, after, kept: yield* session.facts };
    }).pipe(Effect.provide(over(failing, Scripted, tools))),
  );
  expect(ran.count).toBe(0);
  expect(Exit.isFailure(asked) ? String(asked.cause) : "").toContain("the disk is full");
  expect(Exit.isFailure(after) ? String(after.cause) : "").toContain("the disk is full");
  expect(tagsIn(kept)).not.toContain("ToolCallDispatched");
  expect(tagsIn(kept)).not.toContain("ToolEnded");
  // The input given after the failure was not written either.
  expect(tagsIn(kept).filter((tag) => tag === "InputArrived")).toHaveLength(1);
});

test("J4: one process writes a file at a time; a lock left by a process that ended is taken over", async () => {
  const file = fileIn();
  const second = await runTest(
    Effect.gen(function* () {
      yield* Layer.build(FileBackedSessionStore(file));
      return yield* Effect.exit(Effect.scoped(Layer.build(FileBackedSessionStore(file))));
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(Exit.isFailure(second) ? String(second.cause) : "").toContain(`${file} is open in another process (pid ${process.pid})`);
  // The scope that held the lock has closed, and removed it.
  expect(() => readFileSync(`${file}.lock`)).toThrow();
  // A process that is not running holds this one.
  writeFileSync(`${file}.lock`, "999999");
  const taken = await runTest(
    Effect.gen(function* () {
      yield* Layer.build(FileBackedSessionStore(file));
      return readFileSync(`${file}.lock`, "utf8");
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(taken).toBe(String(process.pid));
});

test("J4: a last line whose write did not finish is not read, and is cut off before the file is written to again", async () => {
  const file = fileIn();
  const held = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening());
      yield* ask(session, "hello");
      return yield* session.facts;
    }).pipe(Effect.provide(over(FileBackedSessionStore(file)))),
  );
  writeFileSync(file, `${readFileSync(file, "utf8")}{"_tag":"Observed","seq":${held.length + 1},"ti`);
  const read = await runTest(readFacts(file).pipe(Effect.provide(BunServices.layer)));
  expect(read.facts).toEqual(held);
  expect(read.torn).toStartWith('{"_tag":"Observed"');
  const after = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* ask(session, "again");
      return { now: yield* session.facts, read: yield* readFacts(file) };
    }).pipe(Effect.provide(over(FileBackedSessionStore(file)))),
  );
  expect(after.read.torn).toBe("");
  expect(after.read.facts).toEqual(after.now);
  expect(after.now.length).toBeGreaterThan(held.length);
});

test("J4: a file whose facts are not in order is refused", async () => {
  const file = fileIn();
  const held = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening());
      yield* ask(session, "hello");
      return yield* session.facts;
    }).pipe(Effect.provide(over(ephemeralSessionStore()))),
  );
  writeFileSync(file, [held[0], held[2], held[1]].map((fact) => `${line(fact as Fact)}\n`).join(""));
  const read = await runTest(Effect.exit(readFacts(file)).pipe(Effect.provide(BunServices.layer)));
  expect(Exit.isFailure(read) ? String(read.cause) : "").toContain("line 2 holds fact 3 where fact 2 belongs");
});

test("J1: an ephemeral store keeps the facts in memory only; a store opened on facts goes on from them", async () => {
  const held = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(boringOpening());
      yield* ask(session, "hello");
      return yield* session.facts;
    }).pipe(Effect.provide(over(ephemeralSessionStore()))),
  );
  const after = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* ask(session, "again");
      return yield* session.facts;
    }).pipe(Effect.provide(over(ephemeralSessionStore(held)))),
  );
  expect(after.slice(0, held.length) as unknown).toEqual(held);
  expect(tagsIn(after.slice(held.length)) as Array<string>).toContain("TurnStarted");
  expect(after.find((fact) => fact.seq > held.length && fact._tag === "Observed" && fact.observation._tag === "TurnStarted") as unknown).toMatchObject({
    observation: { turn: "turn-2" },
  });
});
