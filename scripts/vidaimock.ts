/**
 * Installs VidaiMock (https://github.com/vidaiUK/VidaiMock), a mock server that answers like the
 * model providers' APIs, into `.tools/vidaimock/`, where the tests start it.
 *
 *   bun scripts/vidaimock.ts
 *
 * The release archive for this platform is downloaded and checked against the SHA-256 held here,
 * so a changed archive is refused rather than run. An installed binary of this version is kept.
 * To move to another version, change `version` and the hashes to that release's `.sha256` files.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const version = "v0.3.1";
export const installDir = ".tools/vidaimock";
export const binaryPath = join(installDir, "vidaimock", "vidaimock");

const archives: Record<string, { readonly file: string; readonly sha256: string }> = {
  "darwin-arm64": {
    file: "vidaimock-macos-arm64.tar.gz",
    sha256: "db7033d8d79c79e0cc19f7714ab753f87e7f511113ce16fb0937dd5401757fe9",
  },
  "darwin-x64": {
    file: "vidaimock-macos-x64.tar.gz",
    sha256: "4e673267893550c596232e88aaedeef7afe3626aa0c14cff785a1a0b833c8884",
  },
  "linux-arm64": {
    file: "vidaimock-linux-arm64.tar.gz",
    sha256: "65e14b5ffef5bb21322c4a6db4fe6e1c430b011334b1f905d55b0db7490b9ff1",
  },
  "linux-x64": {
    file: "vidaimock-linux-x64.tar.gz",
    sha256: "d228cb27be8835d0e6f538f1cde5c7fcc1675223b7f7c0cb05218df1954d72c5",
  },
};

const versionFile = join(installDir, "VERSION");

async function install(): Promise<void> {
  if (existsSync(binaryPath) && existsSync(versionFile) && (await Bun.file(versionFile).text()).trim() === version) return;
  const platform = `${process.platform}-${process.arch}`;
  const archive = archives[platform];
  if (archive === undefined) throw new Error(`VidaiMock ${version} has no archive for ${platform} listed here`);
  const url = `https://github.com/vidaiUK/VidaiMock/releases/download/${version}/${archive.file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`downloading ${url} failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (sha256 !== archive.sha256) throw new Error(`${archive.file} has SHA-256 ${sha256}, expected ${archive.sha256}`);
  rmSync(installDir, { recursive: true, force: true });
  mkdirSync(installDir, { recursive: true });
  const archivePath = join(installDir, archive.file);
  await Bun.write(archivePath, bytes);
  const untar = Bun.spawnSync(["tar", "-xzf", archive.file], { cwd: installDir });
  if (untar.exitCode !== 0) throw new Error(`unpacking ${archive.file} failed: ${untar.stderr.toString()}`);
  rmSync(archivePath);
  // macOS marks downloaded files as quarantined; the release binary is not platform-signed.
  if (process.platform === "darwin") Bun.spawnSync(["xattr", "-d", "com.apple.quarantine", binaryPath]);
  await Bun.write(versionFile, `${version}\n`);
  console.log(`VidaiMock ${version} installed at ${binaryPath}`);
}

if (import.meta.main) await install();
