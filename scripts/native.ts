/**
 * Builds or tests the Rust code under `native/`: `bun scripts/native.ts build` (`bun run native:build`)
 * or `bun scripts/native.ts test` (`bun run native:test`). `bun run check` runs both first.
 *
 * - `build` compiles `native/bash-segments` to WebAssembly (`wasm32-unknown-unknown`), the module that
 *   `src/agent-policy/command-segments.ts` loads.
 * - `test` runs the crate's own tests, natively.
 *
 * Both use the versions in the crate's `Cargo.lock` (`--locked`). Without `cargo`, or without the
 * `wasm32-unknown-unknown` target, the script exits 1 with an ERROR and a HINT.
 */

const crate = new URL("../native/bash-segments/Cargo.toml", import.meta.url).pathname;
const task = process.argv[2];

const run = (args: ReadonlyArray<string>): number => Bun.spawnSync(["cargo", ...args], { stdout: "inherit", stderr: "inherit" }).exitCode;

if (Bun.which("cargo") === null) {
  console.error("ERROR: cargo is not on the PATH, and the command parser is Rust (native/bash-segments).");
  console.error("HINT: Install Rust with rustup, and put its bin folder on the PATH.");
  process.exit(1);
}

if (task === "build") {
  const targets = Bun.spawnSync(["rustup", "target", "list", "--installed"], { stdout: "pipe", stderr: "pipe" });
  if (targets.exitCode === 0 && !targets.stdout.toString().split("\n").includes("wasm32-unknown-unknown")) {
    console.error("ERROR: The wasm32-unknown-unknown target is not installed, and the command parser is built for it.");
    console.error("HINT: Run rustup target add wasm32-unknown-unknown.");
    process.exit(1);
  }
  process.exit(run(["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "--manifest-path", crate]));
} else if (task === "test") {
  process.exit(run(["test", "--locked", "--manifest-path", crate]));
} else {
  console.error(`ERROR: Unknown task: ${task ?? "(none)"}.`);
  console.error("HINT: Run bun scripts/native.ts build, or bun scripts/native.ts test.");
  process.exit(2);
}
