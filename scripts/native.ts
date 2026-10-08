/**
 * Builds, checks or tests the Rust code under `native/`: `bun scripts/native.ts build`
 * (`bun run native:build`), `check` (`bun run native:check`) or `test` (`bun run native:test`).
 * `bun run check` runs `check` and `test` first.
 *
 * - `build` compiles `native/bash-segments` to WebAssembly (`wasm32-unknown-unknown`) and copies the
 *   module to `native/bash-segments/bash_segments.wasm`, which is committed, so that a project that
 *   depends on this repository by git has the command parser without Rust.
 * - `check` compiles it and fails when the module differs from the committed one: a change to the
 *   crate is committed with the module it builds.
 * - `test` runs the crate's own tests, natively.
 *
 * The build is reproducible: the toolchain is the crate's `rust-toolchain.toml`, the dependencies its
 * `Cargo.lock` (`--locked`), and the paths compiled into the module (the panic messages' source
 * files) are remapped from this machine's folders to fixed ones (`/cargo`, `/bash-segments`). Without
 * `cargo`, the script exits 1 with an ERROR and a HINT.
 */

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const crate = new URL("../native/bash-segments", import.meta.url).pathname;
const built = join(crate, "target", "wasm32-unknown-unknown", "release", "bash_segments.wasm");
const committed = join(crate, "bash_segments.wasm");
const task = process.argv[2];

// The folders whose paths would be compiled into the module, each remapped to a fixed one. Cargo reads
// CARGO_ENCODED_RUSTFLAGS as its arguments separated by 0x1f, so a path with a space stays one argument.
const cargoHome = process.env["CARGO_HOME"] ?? join(homedir(), ".cargo");
const rustflags = [`--remap-path-prefix=${cargoHome}=/cargo`, `--remap-path-prefix=${crate}=/bash-segments`].join("\x1f");

const run = (args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}): number =>
  Bun.spawnSync(["cargo", ...args], { cwd: crate, env: { ...process.env, ...env }, stdout: "inherit", stderr: "inherit" }).exitCode;

const build = (): number =>
  run(["build", "--locked", "--release", "--target", "wasm32-unknown-unknown"], { CARGO_ENCODED_RUSTFLAGS: rustflags });

if (Bun.which("cargo") === null) {
  console.error("ERROR: cargo is not on the PATH, and the command parser is Rust (native/bash-segments).");
  console.error("HINT: Install Rust with rustup, and put its bin folder on the PATH.");
  process.exit(1);
}

if (task === "build") {
  const code = build();
  if (code !== 0) process.exit(code);
  copyFileSync(built, committed);
  console.log(`Built ${committed}.`);
} else if (task === "check") {
  const code = build();
  if (code !== 0) process.exit(code);
  if (!existsSync(committed) || !Buffer.from(readFileSync(built)).equals(readFileSync(committed))) {
    console.error(`ERROR: The committed command parser (${committed}) is not the module the crate builds.`);
    console.error("HINT: Run bun run native:build, and commit native/bash-segments/bash_segments.wasm.");
    process.exit(1);
  }
} else if (task === "test") {
  process.exit(run(["test", "--locked"]));
} else {
  console.error(`ERROR: Unknown task: ${task ?? "(none)"}.`);
  console.error("HINT: Run bun scripts/native.ts build, check or test.");
  process.exit(2);
}
