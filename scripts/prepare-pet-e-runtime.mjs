import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECTED_RUNTIME_MANIFEST, verifyPetEPackage } from "./verify-pet-e-package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeManifestPath = path.join(repoRoot, "pet-e", "runtime-manifest.json");
const resourcesRoot = path.join(repoRoot, "src-tauri", "resources", "pet-e");
const runtimeCacheRoot = path.join(repoRoot, "src-tauri", "target", "pet-e-runtime");
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

function fail(message) {
  throw new Error(`desktop_pet_e_runtime_prepare_failed: ${message}`);
}

function readManifest() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(runtimeManifestPath, "utf8"));
  } catch (error) {
    fail(`manifest_read:${error instanceof Error ? error.message : String(error)}`);
  }
  if (!manifest || typeof manifest !== "object") {
    fail("manifest_fields");
  }
  for (const [key, expected] of Object.entries(EXPECTED_RUNTIME_MANIFEST)) {
    if (manifest[key] !== expected) fail(`manifest_${key}`);
  }
  return manifest;
}

function isWindowsTarget() {
  const targetPlatform = process.env.TAURI_ENV_PLATFORM;
  return targetPlatform === "windows" || targetPlatform === "win32" || (!targetPlatform && process.platform === "win32");
}

function isSupportedArchitecture() {
  const targetArch = process.env.TAURI_ENV_ARCH ?? process.arch;
  return targetArch === "x64" || targetArch === "x86_64";
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyArchive(archivePath, expectedSha256) {
  if (!existsSync(archivePath)) fail(`archive_missing:${archivePath}`);
  const actualSha256 = await sha256File(archivePath);
  if (actualSha256 !== expectedSha256) {
    fail(`archive_checksum:${archivePath}`);
  }
}

async function downloadArchive(manifest, destination) {
  let response;
  try {
    response = await fetch(manifest.sourceUrl, {
      headers: { "user-agent": "CLI-Manager-desktop-pet-e-build" },
      redirect: "follow",
    });
  } catch (error) {
    fail(`archive_download:${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok || !response.body || !response.url.startsWith("https://")) {
    fail(`archive_http:${response.status}:${response.url}`);
  }
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) {
        callback(new Error("archive_too_large"));
        return;
      }
      callback(null, chunk);
    },
  });
  const partialPath = `${destination}.partial`;
  rmSync(partialPath, { force: true });
  try {
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(partialPath, { flags: "wx" }));
    rmSync(destination, { force: true });
    cpSync(partialPath, destination);
    rmSync(partialPath, { force: true });
  } catch (error) {
    rmSync(partialPath, { force: true });
    fail(`archive_download_write:${error instanceof Error ? error.message : String(error)}`);
  }
}

async function resolveArchive(manifest) {
  const suppliedArchive = process.env.CLI_MANAGER_PET_E_RUNTIME_ARCHIVE;
  if (suppliedArchive) {
    const archivePath = path.resolve(suppliedArchive);
    await verifyArchive(archivePath, manifest.sha256);
    return archivePath;
  }
  mkdirSync(runtimeCacheRoot, { recursive: true });
  const archivePath = path.join(runtimeCacheRoot, manifest.archive);
  if (existsSync(archivePath)) {
    try {
      await verifyArchive(archivePath, manifest.sha256);
      return archivePath;
    } catch {
      rmSync(archivePath, { force: true });
    }
  }
  await downloadArchive(manifest, archivePath);
  await verifyArchive(archivePath, manifest.sha256);
  return archivePath;
}

function extractArchive(archivePath, destination) {
  rmSync(destination, { recursive: true, force: true });
  const temporaryDirectory = path.join(runtimeCacheRoot, `extract-${process.pid}-${Date.now()}`);
  rmSync(temporaryDirectory, { recursive: true, force: true });
  mkdirSync(temporaryDirectory, { recursive: true });
  const command = [
    "$ErrorActionPreference='Stop'",
    "Expand-Archive -LiteralPath $env:CLI_MANAGER_PET_E_ARCHIVE -DestinationPath $env:CLI_MANAGER_PET_E_EXTRACT -Force",
  ].join("; ");
  let result = null;
  for (const executable of ["powershell.exe", "pwsh.exe"]) {
    result = spawnSync(executable, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLI_MANAGER_PET_E_ARCHIVE: archivePath,
        CLI_MANAGER_PET_E_EXTRACT: temporaryDirectory,
      },
      stdio: "inherit",
      windowsHide: true,
    });
    if (!result.error) break;
  }
  if (!result || result.error || result.status !== 0) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    fail(`archive_extract:${result?.error?.message ?? result?.status ?? "powershell_unavailable"}`);
  }
  if (!existsSync(path.join(temporaryDirectory, "electron.exe"))) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    fail("archive_layout");
  }
  cpSync(temporaryDirectory, destination, { recursive: true });
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function resetGeneratedResources() {
  for (const relativePath of ["runtime", "app", "LICENSES", "NOTICE.md", "runtime-manifest.json", "package-manifest.json"]) {
    rmSync(path.join(resourcesRoot, relativePath), { recursive: true, force: true });
  }
  mkdirSync(resourcesRoot, { recursive: true });
}

function stageApplication() {
  const applicationSource = path.join(repoRoot, "pet-e", "dist");
  if (!existsSync(path.join(applicationSource, "main.js"))) {
    fail("pet_e_build_missing: run npm --prefix pet-e run build first");
  }
  const applicationDestination = path.join(resourcesRoot, "app");
  cpSync(applicationSource, applicationDestination, { recursive: true });
  writeFileSync(path.join(applicationDestination, "package.json"), `${JSON.stringify({
    name: "cli-manager-desktop-pet-e-runtime",
    version: "1.0.0",
    private: true,
    type: "module",
    main: "main.js",
  }, null, 2)}\n`, "utf8");
  cpSync(path.join(repoRoot, "pet-e", "NOTICE.md"), path.join(resourcesRoot, "NOTICE.md"));
  cpSync(path.join(repoRoot, "pet-e", "runtime-manifest.json"), path.join(resourcesRoot, "runtime-manifest.json"));
  mkdirSync(path.join(resourcesRoot, "LICENSES"), { recursive: true });
  cpSync(path.join(repoRoot, "LICENSE"), path.join(resourcesRoot, "LICENSES", "CLI-Manager-AGPL-3.0-or-later.txt"));
  cpSync(path.join(repoRoot, "pet-e", "LICENSES", "README.md"), path.join(resourcesRoot, "LICENSES", "README.md"));
}

export async function preparePetERuntime() {
  if (!isWindowsTarget()) {
    console.log("Desktop Pet E Windows resources skipped on a non-Windows target");
    return;
  }
  if (!isSupportedArchitecture()) fail("unsupported_architecture");
  const manifest = readManifest();
  const archivePath = await resolveArchive(manifest);
  resetGeneratedResources();
  extractArchive(archivePath, path.join(resourcesRoot, "runtime"));
  stageApplication();
  await verifyPetEPackage(resourcesRoot, { writeManifest: true });
  console.log(`Desktop Pet E resources prepared: ${resourcesRoot}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  preparePetERuntime().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
