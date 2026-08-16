import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  createReadStream,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_PACKAGE_FILES = 2048;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 320 * 1024 * 1024;
const PACKAGE_MANIFEST_NAME = "package-manifest.json";

export const EXPECTED_RUNTIME_MANIFEST = Object.freeze({
  schemaVersion: 1,
  runtime: "electron",
  version: "41.10.2",
  platform: "win32",
  arch: "x64",
  archive: "electron-v41.10.2-win32-x64.zip",
  sourceUrl: "https://github.com/electron/electron/releases/download/v41.10.2/electron-v41.10.2-win32-x64.zip",
  checksumUrl: "https://github.com/electron/electron/releases/download/v41.10.2/SHASUMS256.txt",
  sha256: "7665990f65b7d2f61671eb342b08c4b6f2e7ce302a269d56c2f3554fc8c8ce72",
  entry: "electron.exe",
});

function invalid(message) {
  throw new Error(`desktop_pet_e_package_invalid: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) invalid(message);
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    invalid(`invalid_json:${filePath}:${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateRuntimeManifest(manifest) {
  requireCondition(manifest && typeof manifest === "object", "runtime_manifest_shape");
  for (const [key, expected] of Object.entries(EXPECTED_RUNTIME_MANIFEST)) {
    requireCondition(manifest[key] === expected, `runtime_manifest_${key}`);
  }
  requireCondition(/^[0-9a-f]{64}$/.test(manifest.sha256), "runtime_manifest_sha256");
}

function normalizeRelativePath(value) {
  const normalized = value.replaceAll(path.sep, "/");
  requireCondition(
    normalized.length > 0
      && !normalized.startsWith("/")
      && !normalized.includes("../")
      && normalized !== "..",
    `unsafe_path:${value}`,
  );
  return normalized;
}

function listFiles(root) {
  const files = [];
  let totalBytes = 0;

  function visit(current, relativeDirectory) {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = normalizeRelativePath(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
      );
      const absolutePath = path.join(current, entry.name);
      const metadata = lstatSync(absolutePath);
      requireCondition(!metadata.isSymbolicLink(), `symlink:${relativePath}`);
      if (relativePath === PACKAGE_MANIFEST_NAME) {
        requireCondition(entry.isFile(), `unsupported_entry:${relativePath}`);
        continue;
      }
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      requireCondition(entry.isFile(), `unsupported_entry:${relativePath}`);
      requireCondition(metadata.size <= MAX_FILE_BYTES, `file_too_large:${relativePath}`);
      totalBytes += metadata.size;
      requireCondition(totalBytes <= MAX_PACKAGE_BYTES, "package_too_large");
      files.push({ path: relativePath, absolutePath, size: metadata.size });
      requireCondition(files.length <= MAX_PACKAGE_FILES, "too_many_files");
    }
  }

  visit(root, "");
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { files, totalBytes };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function requireFile(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  requireCondition(existsSync(absolutePath) && statSync(absolutePath).isFile(), `missing:${relativePath}`);
  return absolutePath;
}

function validatePortableExecutable(filePath) {
  const bytes = readFileSync(filePath);
  requireCondition(bytes.length >= 0x88, "electron_exe_too_small");
  requireCondition(bytes[0] === 0x4d && bytes[1] === 0x5a, "electron_exe_mz");
  const peOffset = bytes.readUInt32LE(0x3c);
  requireCondition(peOffset + 6 <= bytes.length, "electron_exe_pe_offset");
  requireCondition(bytes.subarray(peOffset, peOffset + 4).toString("ascii") === "PE\u0000\u0000", "electron_exe_pe_signature");
  requireCondition(bytes.readUInt16LE(peOffset + 4) === 0x8664, "electron_exe_architecture");
}

function validatePackageContents(root) {
  requireCondition(existsSync(root) && lstatSync(root).isDirectory(), `root_missing:${root}`);
  const runtimeManifest = readJson(requireFile(root, "runtime-manifest.json"));
  validateRuntimeManifest(runtimeManifest);
  requireCondition(runtimeManifest.entry === "electron.exe", "runtime_manifest_entry");
  requireCondition(readFileSync(requireFile(root, "runtime/version"), "utf8").trim() === "41.10.2", "runtime_version");
  validatePortableExecutable(requireFile(root, "runtime/electron.exe"));

  const appPackage = readJson(requireFile(root, "app/package.json"));
  requireCondition(appPackage.name === "cli-manager-desktop-pet-e-runtime", "app_package_name");
  requireCondition(appPackage.version === "1.0.0", "app_package_version");
  requireCondition(appPackage.private === true, "app_package_private");
  requireCondition(appPackage.type === "module", "app_module_type");
  requireCondition(appPackage.main === "main.js", "app_main_entry");

  for (const requiredPath of [
    "runtime/LICENSE",
    "runtime/LICENSES.chromium.html",
    "runtime/resources/default_app.asar",
    "app/main.js",
    "app/preload.cjs",
    "app/bridge/protocol.js",
    "app/bridge/agent-action.js",
    "app/renderer/index.html",
    "app/renderer/app.js",
    "app/renderer/task-state.js",
    "app/renderer/agent-action.js",
    "app/renderer/styles.css",
    "NOTICE.md",
    "LICENSES/CLI-Manager-AGPL-3.0-or-later.txt",
    "LICENSES/README.md",
  ]) {
    requireFile(root, requiredPath);
  }

  const fileListing = listFiles(root);
  for (const file of fileListing.files) {
    const forbiddenResource = [
      /(^|\/)(clawd|calico|cloudling|node_modules)(\/|$)/i,
      /\.codex-pet(?:$|\/)/i,
      /spritesheet\.webp$/i,
      /(^|\/)themes(\/|$)/i,
      /\.zip$/i,
    ].some((pattern) => pattern.test(file.path));
    requireCondition(!forbiddenResource, `forbidden_resource:${file.path}`);
    requireCondition(file.path.toLowerCase() !== "runtime-manifest.json" || file.size < 16 * 1024, "runtime_manifest_too_large");
  }
  return { runtimeManifest, fileListing };
}

async function buildPackageManifest(root) {
  const { runtimeManifest, fileListing } = validatePackageContents(root);
  const files = [];
  for (const file of fileListing.files) {
    files.push({
      path: file.path,
      size: file.size,
      sha256: await sha256File(file.absolutePath),
    });
  }
  return {
    schemaVersion: 1,
    component: "desktop-pet-e",
    runtime: runtimeManifest,
    files,
  };
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

export async function verifyPetEPackage(root, { writeManifest = false } = {}) {
  const packageManifestPath = path.join(root, PACKAGE_MANIFEST_NAME);
  if (writeManifest && existsSync(packageManifestPath)) {
    rmSync(packageManifestPath, { force: true });
  }
  const manifest = await buildPackageManifest(root);
  if (writeManifest) {
    writeFileSync(packageManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }
  const recorded = readJson(requireFile(root, PACKAGE_MANIFEST_NAME));
  requireCondition(recorded.schemaVersion === 1, "package_manifest_schema");
  requireCondition(recorded.component === "desktop-pet-e", "package_manifest_component");
  requireCondition(canonicalJson(recorded.runtime) === canonicalJson(manifest.runtime), "package_manifest_runtime");
  requireCondition(canonicalJson(recorded.files) === canonicalJson(manifest.files), "package_manifest_files");
  return recorded;
}

function parseArguments(argv) {
  let root = path.join(repoRoot, "src-tauri", "resources", "pet-e");
  let writeManifest = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write-manifest") {
      writeManifest = true;
    } else if (argument === "--root") {
      const next = argv[index + 1];
      requireCondition(next, "root_argument_missing");
      root = path.resolve(next);
      index += 1;
    } else {
      invalid(`unknown_argument:${argument}`);
    }
  }
  return { root, writeManifest };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  await verifyPetEPackage(options.root, { writeManifest: options.writeManifest });
  console.log(`Desktop Pet E package verified: ${options.root}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
