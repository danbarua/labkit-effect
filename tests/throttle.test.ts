import { expect } from "bun:test";
import { test } from "./support/test.ts";
import { Millis } from "../src/agent-core/names.ts";
import { emptyHeld, type Held, type ThrottleInput, throttle } from "../src/agent-core/throttle.ts";

function run(interval: number, inputs: ReadonlyArray<ThrottleInput<number>>): Array<Array<number>> {
  let held: Held<number> = emptyHeld();
  const batches: Array<Array<number>> = [];
  for (const input of inputs) {
    const step = throttle(Millis.make(interval), held, input);
    held = step.held;
    if (step.batch.length > 0) batches.push([...step.batch]);
  }
  return batches;
}

const at = (ms: number) => Millis.make(ms);

test("chunks are released at most once per interval, and the rest when the stream ends", () => {
  expect(
    run(100, [
      { _tag: "Captured", item: 1, at: at(0) },
      { _tag: "Captured", item: 2, at: at(30) },
      { _tag: "Captured", item: 3, at: at(60) },
      { _tag: "Tick", at: at(99) },
      { _tag: "Tick", at: at(100) },
      { _tag: "Captured", item: 4, at: at(150) },
      { _tag: "Ended", at: at(160) },
    ]),
  ).toEqual([[1], [2, 3], [4]]);
});

test("nothing held, nothing released", () => {
  expect(run(100, [{ _tag: "Tick", at: at(500) }, { _tag: "Ended", at: at(600) }])).toEqual([]);
});
