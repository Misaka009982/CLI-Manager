import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetRoot = path.join(repoRoot, "src-tauri", "target");
const profile = process.env.TAURI_ENV_DEBUG === "true" ? "debug" : "release";
const universalDir = path.join(targetRoot, "universal-apple-darwin", profile);
const helperBinaryNames = ["cli-manager-daemon", "cli-manager-codex-proxy"];
const targetPlatform = process.env.TAURI_ENV_PLATFORM ?? (process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : process.platform);

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    console.error(`${label} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${label} failed with exit code ${result.status ?? "unknown"}`);
    process.exit(result.status ?? 1);
  }
}

if (targetPlatform === "windows" || targetPlatform === "win32") {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  run(npmCommand, ["run", "build:pet-e"], "Desktop Pet E build");
  run(process.execPath, ["scripts/prepare-pet-e-runtime.mjs"], "Desktop Pet E resource preparation");
  process.exit(0);
}

if (targetPlatform !== "darwin" || process.env.TAURI_ENV_ARCH !== "universal") {
  process.exit(0);
}

mkdirSync(universalDir, { recursive: true });

for (const binaryName of helperBinaryNames) {
  const arm64 = path.join(targetRoot, "aarch64-apple-darwin", profile, binaryName);
  const x64 = path.join(targetRoot, "x86_64-apple-darwin", profile, binaryName);
  const output = path.join(universalDir, binaryName);

  for (const binary of [arm64, x64]) {
    if (!existsSync(binary)) {
      console.error(`Missing architecture-specific helper binary (${binaryName}): ${binary}`);
      process.exit(1);
    }
  }

  run("lipo", ["-create", arm64, x64, "-output", output], `lipo ${binaryName}`);
}
