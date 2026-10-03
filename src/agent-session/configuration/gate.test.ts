/** The configuration gate: a user's change made at once between turns, held during one and made when it ends. */

import { expect } from "bun:test";
import { Effect, Ref } from "effect";
import { test } from "../../../tests/support/test.ts";
import { makeConfigurationGate } from "./gate.ts";

interface Change {
  readonly model?: string;
  readonly settings?: Readonly<Record<string, string>>;
}

/** A gate over a turn that runs while `running` says so, recording each change it makes. */
const gated = Effect.gen(function* () {
  const running = yield* Ref.make(false);
  const made = yield* Ref.make<ReadonlyArray<Change>>([]);
  const gate = yield* makeConfigurationGate<Change, never>({
    running: Ref.get(running),
    merge: (held, next) => ({ ...held, ...next, settings: { ...held.settings, ...next.settings } }),
    make: (change) => Ref.update(made, (before) => [...before, change]),
  });
  return { running, made, gate };
});

test("G1: while no turn runs a change is made at once", () => {
  const { said, made } = Effect.runSync(
    Effect.gen(function* () {
      const { made, gate } = yield* gated;
      return { said: yield* gate.submit({ model: "b" }), made: yield* Ref.get(made) };
    }),
  );
  expect(said).toBe("made");
  expect(made).toEqual([{ model: "b" }]);
});

test("G2: while a turn runs changes are held, merged in order, and made as one when it ends (settle); settle makes nothing while a turn runs, or with nothing held", () => {
  const seen = Effect.runSync(
    Effect.gen(function* () {
      const { running, made, gate } = yield* gated;
      yield* Ref.set(running, true);
      const said = [yield* gate.submit({ model: "b", settings: { effort: "low" } }), yield* gate.submit({ settings: { thinking: "off" } })];
      // Settling while the turn still runs makes nothing.
      yield* gate.settle;
      const during = yield* Ref.get(made);
      const held = yield* gate.held;
      yield* Ref.set(running, false);
      yield* gate.settle;
      yield* gate.settle;
      return { said, during, held, after: yield* Ref.get(made), heldAfter: yield* gate.held };
    }),
  );
  expect(seen).toEqual({
    said: ["held", "held"],
    during: [],
    held: { model: "b", settings: { effort: "low", thinking: "off" } },
    after: [{ model: "b", settings: { effort: "low", thinking: "off" } }],
    heldAfter: undefined,
  });
});

test("G3: a change submitted once the turn has ended, before the host settles, is made with the one held, not lost", () => {
  const made = Effect.runSync(
    Effect.gen(function* () {
      const { running, made, gate } = yield* gated;
      yield* Ref.set(running, true);
      yield* gate.submit({ model: "b" });
      yield* Ref.set(running, false);
      yield* gate.submit({ settings: { effort: "high" } });
      yield* gate.settle;
      return yield* Ref.get(made);
    }),
  );
  expect(made).toEqual([{ model: "b", settings: { effort: "high" } }]);
});
