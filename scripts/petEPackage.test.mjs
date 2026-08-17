import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPetEPackage } from "./verify-pet-e-package.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRuntimeManifest = JSON.parse(readFileSync(path.join(repositoryRoot, "pet-e", "runtime-manifest.json"), "utf8"));

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function fakeWindowsX64Executable() {
  const executable = Buffer.alloc(512);
  executable.writeUInt16LE(0x5a4d, 0);
  executable.writeUInt32LE(0x80, 0x3c);
  executable.write("PE\u0000\u0000", 0x80, "ascii");
  executable.writeUInt16LE(0x8664, 0x84);
  return executable;
}

function createPackageFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "cli-manager-pet-e-package-"));
  temporaryRoots.push(root);
  writeFile(root, "runtime-manifest.json", `${JSON.stringify(sourceRuntimeManifest)}\n`);
  writeFile(root, "runtime/electron.exe", fakeWindowsX64Executable());
  writeFile(root, "runtime/version", "41.10.2\n");
  writeFile(root, "runtime/LICENSE", "Electron license\n");
  writeFile(root, "runtime/LICENSES.chromium.html", "Chromium notices\n");
  writeFile(root, "runtime/resources/default_app.asar", "asar\n");
  writeFile(root, "app/package.json", `${JSON.stringify({
    name: "cli-manager-desktop-pet-e-runtime",
    version: "1.0.0",
    private: true,
    type: "module",
    main: "main.js",
  })}\n`);
  for (const relativePath of [
    "app/main.js",
    "app/preload.cjs",
    "app/bridge/protocol.js",
    "app/bridge/agent-action.js",
    "app/renderer/index.html",
    "app/renderer/app.js",
    "app/renderer/task-state.js",
    "app/renderer/agent-action.js",
    "app/renderer/styles.css",
  ]) {
    writeFile(root, relativePath, "static\n");
  }
  writeFile(root, "NOTICE.md", "notice\n");
  writeFile(root, "LICENSES/CLI-Manager-AGPL-3.0-or-later.txt", "license\n");
  writeFile(root, "LICENSES/README.md", "license readme\n");
  return root;
}

const temporaryRoots = [];
process.on("exit", () => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

// 每个测试使用独立目录，避免上一轮生成的 package manifest 掩盖缺失文件。
function freshPackageFixture() {
  return createPackageFixture();
}

test("完整 Windows x64 package writes and verifies a per-file manifest", async () => {
  const root = freshPackageFixture();
  const manifest = await verifyPetEPackage(root, { writeManifest: true });
  assert.equal(manifest.component, "desktop-pet-e");
  assert.ok(manifest.files.some((file) => file.path === "runtime/electron.exe"));
  assert.ok(!manifest.files.some((file) => file.path === "package-manifest.json"));
  await verifyPetEPackage(root);
});

test("package verification rejects copied Clawd or Codex artwork", async () => {
  const root = freshPackageFixture();
  writeFile(root, "themes/clawd/idle.svg", "forbidden\n");
  await assert.rejects(
    () => verifyPetEPackage(root, { writeManifest: true }),
    /forbidden_resource/,
  );
});

test("package verification rejects a non-x64 Electron executable", async () => {
  const root = freshPackageFixture();
  const executable = fakeWindowsX64Executable();
  executable.writeUInt16LE(0x014c, 0x84);
  writeFile(root, "runtime/electron.exe", executable);
  await assert.rejects(
    () => verifyPetEPackage(root, { writeManifest: true }),
    /electron_exe_architecture/,
  );
});

test("package verification rejects CommonJS runtime metadata", async () => {
  const root = freshPackageFixture();
  writeFile(root, "app/package.json", JSON.stringify({
    name: "cli-manager-desktop-pet-e-runtime",
    version: "1.0.0",
    private: true,
    type: "commonjs",
    main: "main.js",
  }));
  await assert.rejects(
    () => verifyPetEPackage(root, { writeManifest: true }),
    /app_module_type/,
  );
});

test("resource chain uses the resolver path and never stages runtime at launch", () => {
  const tauri = readFileSync(path.join(repositoryRoot, "src-tauri/tauri.windows.conf.json"), "utf8");
  const baseTauri = readFileSync(path.join(repositoryRoot, "src-tauri/tauri.conf.json"), "utf8");
  const alphaRelease = readFileSync(path.join(repositoryRoot, ".github/workflows/alpha-release.yml"), "utf8");
  const prepareBundle = readFileSync(path.join(repositoryRoot, "scripts/prepare-bundle-binaries.mjs"), "utf8");
  const prepare = readFileSync(path.join(repositoryRoot, "scripts/prepare-pet-e-runtime.mjs"), "utf8");
  const manager = readFileSync(path.join(repositoryRoot, "src-tauri/src/commands/desktop_pet_e.rs"), "utf8");
  const portable = readFileSync(path.join(repositoryRoot, "scripts/package-portable.ps1"), "utf8");

  assert.match(tauri, /"resources\/pet-e\/":\s*"pet-e\/"/);
  assert.doesNotMatch(baseTauri, /resources\/pet-e/);
  assert.match(alphaRelease, /path: src-tauri\/target\/pet-e-runtime/);
  assert.match(alphaRelease, /npm install --prefix pet-e --ignore-scripts/);
  assert.doesNotMatch(alphaRelease, /prepare-electron-pet-runtime/);
  assert.doesNotMatch(alphaRelease, /node \.\/scripts\/prepare-pet-e-runtime\.mjs/);
  assert.match(prepareBundle, /process\.env\.ComSpec \|\| "cmd\.exe"/);
  assert.match(prepareBundle, /\["\/d", "\/s", "\/c", "npm\.cmd", \.\.\.args\]/);
  assert.doesNotMatch(prepareBundle, /run\(npmCommand/);
  assert.match(prepare, /CLI_MANAGER_PET_E_RUNTIME_ARCHIVE/);
  assert.match(prepare, /7665990f65b7d2f61671eb342b08c4b6f2e7ce302a269d56c2f3554fc8c8ce72/);
  assert.match(prepare, /appPackage|package\.json/);
  assert.match(prepare, /version: "1\.0\.0"/);
  assert.match(manager, /pet-e\/runtime\/electron\.exe/);
  assert.match(manager, /pet-e\/app\/main\.js/);
  assert.match(manager, /PET_E_PACKAGE_MANIFEST_RELATIVE_PATH/);
  assert.match(manager, /ELECTRON_RUNTIME_SHA256/);
  assert.match(manager, /sha256_file/);
  assert.match(manager, /eq_ignore_ascii_case\(&actual_sha256\)/);
  assert.match(portable, /verify-pet-e-package\.mjs/);
  assert.doesNotMatch(manager, /fetch\(|reqwest::/);
});
