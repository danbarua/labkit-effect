/**
 * Opens VS Code with labkit's ACP client, built first, and this checkout's ACP agent registered in
 * it as `labkit-effect`, on a folder: the argument, else this checkout.
 *
 * VS Code runs with user data of its own (`~/.<brand>/vscode-dev`), so the user's own settings are
 * not changed; its `settings.json` there gets `acp.agents` on each run, and keeps what else is set
 * in it. The client is loaded as a development extension, as labkit's `vscode:dev` loads it.
 *
 * `LABKIT_VSCODE_CLIENT` is the client's package folder (labkit-web's `packages/app-vscode`); set it
 * in `.env`. `<PREFIX>ACP_MODEL` (`LABKIT_ACP_MODEL` for labkit's), when set, is the model new
 * sessions start on. The brand is the one the environment names (`agent-host/brand.ts`); the agent is
 * given the meta variable too, so it runs as the same one.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { brandFrom, brandVariable, envPrefixOf, folderOf } from "../src/agent-host/brand.ts";

const client = process.env["LABKIT_VSCODE_CLIENT"];
if (client === undefined || !existsSync(join(client, "package.json"))) {
  console.error(
    `LABKIT_VSCODE_CLIENT is ${client === undefined ? "not set" : `${client}, which holds no package.json`}. Set it in .env to the folder of labkit's VS Code client (labkit-web's packages/app-vscode).`,
  );
  process.exit(1);
}

const root = resolve(import.meta.dir, "..");
const folder = resolve(process.argv[2] ?? root);

const built = Bun.spawnSync(["bun", "run", "build"], { cwd: client, stdout: "inherit", stderr: "inherit" });
if (built.exitCode !== 0) {
  console.error(`The client did not build (bun run build in ${client} exited ${built.exitCode}).`);
  process.exit(1);
}

const brand = brandFrom(process.env);
const modelVariable = `${envPrefixOf(brand)}ACP_MODEL`;
const userData = join(homedir(), folderOf(brand), "vscode-dev");
const settingsFile = join(userData, "User", "settings.json");
mkdirSync(join(userData, "User"), { recursive: true });
const before: Record<string, unknown> = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
const model = process.env[modelVariable];
const named = process.env[brandVariable];
const settings = {
  ...before,
  "acp.agents": {
    "labkit-effect": {
      command: process.execPath,
      args: [join(root, "src", "agent-acp", "main.ts")],
      env: { ...(named === undefined ? {} : { [brandVariable]: named }), ...(model === undefined ? {} : { [modelVariable]: model }) },
    },
  },
  "acp.autoApprovePermissions": "ask",
};
writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

console.error(`Opening ${folder} in VS Code (user data ${userData}), with the client from ${client}.`);
Bun.spawn(["code", "--user-data-dir", userData, `--extensionDevelopmentPath=${client}`, "--new-window", folder], {
  stdout: "inherit",
  stderr: "inherit",
});
