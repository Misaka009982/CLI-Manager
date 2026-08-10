import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ELECTRON_PET_RUNTIME_VERSION = "41.10.2";
const PROTOCOL_VERSION = 1;
const RELEASE_BASE_URL = "https://github.com/electron/electron/releases/download";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const sourceRoot = path.join(repoRoot, "electron-pet");
const outputRoot = path.join(repoRoot, "src-tauri", "resources", "electron-pet");
const cacheRoot = path.join(
  repoRoot,
  "src-tauri",
  "target",
  "electron-runtime-cache",
  `v${ELECTRON_PET_RUNTIME_VERSION}`
);

function runtimeArchitecture() {
  const architecture = process.env.TAURI_ENV_ARCH || process.arch;
  if (["aarch64", "arm64"].includes(architecture)) return "arm64";
  if (["x86_64", "x64"].includes(architecture)) return "x64";
  throw new Error(`Unsupported Windows Electron runtime architecture: ${architecture}`);
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filePath);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

function sourceFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(entryPath));
    else if (entry.isFile()) result.push(entryPath);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function sourceFingerprint() {
  const hash = createHash("sha256");
  for (const filePath of sourceFiles(sourceRoot)) {
    hash.update(path.relative(sourceRoot, filePath).replaceAll(path.sep, "/"));
    hash.update("\0");
    hash.update(readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function fetchWithRetry(url, retries = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "CLI-Manager-Electron-Pet-Bundler/1" },
        redirect: "follow",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  throw new Error(`Failed to download ${url}: ${lastError}`);
}

async function downloadFile(url, destination) {
  const response = await fetchWithRetry(url);
  if (!response.body) throw new Error(`Download response has no body: ${url}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function officialArchiveChecksum(archiveName) {
  const checksumUrl = `${RELEASE_BASE_URL}/v${ELECTRON_PET_RUNTIME_VERSION}/SHASUMS256.txt`;
  const response = await fetchWithRetry(checksumUrl);
  const body = await response.text();
  const line = body
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().endsWith(archiveName));
  const checksum = line?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) {
    throw new Error(`Official checksum is missing for ${archiveName}`);
  }
  return checksum;
}

function extractArchive(archivePath, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const command = "& { param([string]$Archive, [string]$Destination) Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force }";
  const executables = ["pwsh.exe", "powershell.exe"];
  let lastResult = null;
  for (const executable of executables) {
    const result = spawnSync(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command, archivePath, destination],
      { cwd: repoRoot, stdio: "inherit", windowsHide: true }
    );
    lastResult = result;
    if (!result.error && result.status === 0) return;
    if (result.error?.code !== "ENOENT") break;
  }
  throw new Error(
    `Failed to extract Electron runtime: ${lastResult?.error?.message || lastResult?.status || "unknown"}`
  );
}

function runtimeRequiredFiles(root) {
  return [
    path.join(root, "electron.exe"),
    path.join(root, "chrome_100_percent.pak"),
    path.join(root, "resources", "default_app.asar"),
  ];
}

function validateRuntime(root) {
  for (const required of runtimeRequiredFiles(root)) {
    if (!existsSync(required) || !statSync(required).isFile()) {
      throw new Error(`Electron runtime file is missing: ${required}`);
    }
  }
}

function existingOutputMatches(architecture, fingerprint) {
  const manifestPath = path.join(outputRoot, "runtime-manifest.json");
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      manifest.electronVersion !== ELECTRON_PET_RUNTIME_VERSION
      || manifest.architecture !== architecture
      || manifest.protocolVersion !== PROTOCOL_VERSION
      || manifest.sourceSha256 !== fingerprint
    ) {
      return false;
    }
    validateRuntime(outputRoot);
    return existsSync(path.join(outputRoot, "app", "main.cjs"))
      && existsSync(path.join(outputRoot, "protocol.cjs"));
  } catch {
    return false;
  }
}

export async function prepareElectronPetRuntime() {
  if (process.env.TAURI_ENV_PLATFORM !== "windows") return;

  const architecture = runtimeArchitecture();
  const fingerprint = sourceFingerprint();
  if (existingOutputMatches(architecture, fingerprint)) return;

  const archiveName = `electron-v${ELECTRON_PET_RUNTIME_VERSION}-win32-${architecture}.zip`;
  const archivePath = path.join(cacheRoot, archiveName);
  const checksum = (
    process.env.CLI_MANAGER_ELECTRON_RUNTIME_SHA256
    || await officialArchiveChecksum(archiveName)
  ).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    throw new Error("CLI_MANAGER_ELECTRON_RUNTIME_SHA256 must be a SHA-256 hex digest");
  }

  if (!existsSync(archivePath)) {
    await downloadFile(
      `${RELEASE_BASE_URL}/v${ELECTRON_PET_RUNTIME_VERSION}/${archiveName}`,
      archivePath
    );
  }
  let actualChecksum = await sha256File(archivePath);
  if (actualChecksum !== checksum) {
    rmSync(archivePath, { force: true });
    await downloadFile(
      `${RELEASE_BASE_URL}/v${ELECTRON_PET_RUNTIME_VERSION}/${archiveName}`,
      archivePath
    );
    actualChecksum = await sha256File(archivePath);
  }
  if (actualChecksum !== checksum) {
    throw new Error(
      `Electron runtime checksum mismatch: expected ${checksum}, received ${actualChecksum}`
    );
  }

  const extractionRoot = path.join(cacheRoot, `extracted-${architecture}`);
  extractArchive(archivePath, extractionRoot);
  validateRuntime(extractionRoot);

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  cpSync(extractionRoot, outputRoot, { recursive: true, force: true });
  cpSync(path.join(sourceRoot, "app"), path.join(outputRoot, "app"), {
    recursive: true,
    force: true,
  });
  cpSync(
    path.join(sourceRoot, "protocol.cjs"),
    path.join(outputRoot, "protocol.cjs"),
    { force: true }
  );
  writeFileSync(
    path.join(outputRoot, "runtime-manifest.json"),
    `${JSON.stringify({
      electronVersion: ELECTRON_PET_RUNTIME_VERSION,
      architecture,
      protocolVersion: PROTOCOL_VERSION,
      archiveSha256: actualChecksum,
      sourceSha256: fingerprint,
    }, null, 2)}\n`,
    "utf8"
  );
  validateRuntime(outputRoot);
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await prepareElectronPetRuntime();
}
