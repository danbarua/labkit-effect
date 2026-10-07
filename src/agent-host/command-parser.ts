/**
 * The host's command parser: the WebAssembly module of the Rust crate `native/bash-segments` (built by
 * `bun run native:build`), loaded on first use and then called synchronously. `segmentsOf` writes a
 * command into the module's memory, calls its `segments_json`, reads the JSON it returns, and decodes
 * it as `agent-policy/command-segments.ts`'s `Segments`.
 *
 * When the module is not built, does not load, traps, or answers in a form that is not known, the
 * command is `Unparsed` with the reason, so that the permission policy asks about it.
 */

import { existsSync, readFileSync } from "node:fs";
import { Schema } from "effect";
import { Segments, type SegmentsOf, UnparsedReason } from "../agent-policy/command-segments.ts";

/** Where `bun run native:build` writes the module. */
export const modulePath = new URL("../../native/bash-segments/target/wasm32-unknown-unknown/release/bash_segments.wasm", import.meta.url).pathname;

interface ParserExports {
  readonly memory: WebAssembly.Memory;
  readonly segments_alloc: (len: number) => number;
  readonly segments_free: (pointer: number, len: number) => void;
  readonly segments_json: (pointer: number, len: number) => bigint;
}

type Loaded = { readonly _tag: "Loaded"; readonly exports: ParserExports } | { readonly _tag: "NotLoaded"; readonly reason: string };

let loaded: Loaded | undefined;

/**
 * Returns imports for each function `module` imports, each of which throws when called. The module
 * imports wasm-bindgen's hooks because some of brush-parser's dependencies (getrandom, web-time) link
 * them on `wasm32`; splitting a command calls none of them, so a call is a failure, named.
 */
const unprovided = (module: WebAssembly.Module): Record<string, Record<string, () => never>> => {
  const imports: Record<string, Record<string, () => never>> = {};
  for (const { module: from, name, kind } of WebAssembly.Module.imports(module)) {
    if (kind !== "function") continue;
    imports[from] ??= {};
    imports[from][name] = () => {
      throw new Error(`The command parser called ${from}.${name}, which is not provided.`);
    };
  }
  return imports;
};

const load = (): Loaded => {
  if (!existsSync(modulePath)) return { _tag: "NotLoaded", reason: `The command parser is not built (${modulePath}). Run bun run native:build.` };
  try {
    const module = new WebAssembly.Module(readFileSync(modulePath));
    const instance = new WebAssembly.Instance(module, unprovided(module));
    return { _tag: "Loaded", exports: instance.exports as unknown as ParserExports };
  } catch (error) {
    return { _tag: "NotLoaded", reason: `The command parser did not load (${modulePath}): ${String(error)}` };
  }
};

/** Returns the module's JSON for `command`, or why the module could not answer. */
const segmentsJsonOf = (command: string): { readonly json: string } | { readonly reason: string } => {
  loaded ??= load();
  if (loaded._tag === "NotLoaded") return { reason: loaded.reason };
  const { memory, segments_alloc, segments_free, segments_json } = loaded.exports;
  const input = new TextEncoder().encode(command);
  try {
    const pointer = segments_alloc(input.length);
    new Uint8Array(memory.buffer, pointer, input.length).set(input);
    const packed = segments_json(pointer, input.length);
    segments_free(pointer, input.length);
    const outPointer = Number(packed >> 32n);
    const outLength = Number(packed & 0xffffffffn);
    const json = new TextDecoder().decode(new Uint8Array(memory.buffer, outPointer, outLength));
    segments_free(outPointer, outLength);
    return { json };
  } catch (error) {
    // A trap leaves the module's memory in an unknown state, so the next call loads it afresh.
    loaded = undefined;
    return { reason: `The command parser failed: ${String(error)}` };
  }
};

/** Returns the segments of `command`, as the command parser splits it. */
export const segmentsOf: SegmentsOf = (command) => {
  const answered = segmentsJsonOf(command);
  if ("reason" in answered) return { _tag: "Unparsed", reason: UnparsedReason.make(answered.reason) };
  const decoded = Schema.decodeOption(Schema.fromJsonString(Segments))(answered.json);
  return decoded._tag === "Some" ? decoded.value : { _tag: "Unparsed", reason: UnparsedReason.make(`The command parser answered in a form that is not known: ${answered.json.slice(0, 200)}`) };
};
