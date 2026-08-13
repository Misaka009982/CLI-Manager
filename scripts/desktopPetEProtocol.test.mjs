import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Desktop Pet E commands and shutdown are registered in the Tauri application", () => {
  const commands = read("../src-tauri/src/commands/mod.rs");
  const lib = read("../src-tauri/src/lib.rs");

  assert.match(commands, /pub mod desktop_pet_e;/);
  assert.match(lib, /mod desktop_pet_e_bridge;/);
  assert.match(lib, /manage\(commands::desktop_pet_e::DesktopPetEManager::new\(\)\)/);
  assert.match(lib, /commands::desktop_pet_e::desktop_pet_e_sync/);
  assert.match(lib, /commands::desktop_pet_e::desktop_pet_e_runtime_state/);
  assert.match(lib, /RunEvent::Exit[\s\S]*DesktopPetEManager[\s\S]*\.shutdown\(app\)/);
});

test("the companion uses parent-child pipes and Windows process governance without a listener", () => {
  const manager = read("../src-tauri/src/commands/desktop_pet_e.rs");

  assert.match(manager, /silent_command\(&runtime\.to_string_lossy\(\)\)/);
  assert.match(manager, /\.stdin\(Stdio::piped\(\)\)/);
  assert.match(manager, /\.stdout\(Stdio::piped\(\)\)/);
  assert.match(manager, /ChildJob::assign\(&child, "Desktop Pet E"\)/);
  assert.match(manager, /process\.job\.terminate\(\)/);
  assert.doesNotMatch(manager, /TcpListener|UdpSocket|listen\(|127\.0\.0\.1/);
});

test("the manager allows one restart and disables E after the next failure", () => {
  const manager = read("../src-tauri/src/commands/desktop_pet_e.rs");

  assert.match(manager, /schedule_restart_after_failure\(&mut state\)/);
  assert.match(manager, /state\.restart_count = 1;/);
  assert.match(manager, /state\.enabled = false;/);
  assert.match(manager, /desktop_pet_e_restart_failed/);
  assert.match(manager, /READY_TIMEOUT/);
  assert.match(manager, /lifecycle_restarts_only_once_before_disabling/);
});

test("both backend start paths enforce mutual exclusion", () => {
  const manager = read("../src-tauri/src/commands/desktop_pet_e.rs");
  const existingPet = read("../src-tauri/src/commands/desktop_pet.rs");
  const existingCoordinator = read("../src/hooks/useDesktopPetCoordinator.ts");

  assert.match(manager, /request\.enabled[\s\S]*request\.existing_desktop_pet_enabled[\s\S]*state\.existing_desktop_pet_enabled/);
  assert.match(manager, /desktop_pet_e_mutual_exclusion/);
  assert.match(existingPet, /synchronize_existing_desktop_pet\(config\.configured_enabled\.unwrap_or\(config\.enabled\)\)/);
  assert.match(manager, /desktop_pet_mutual_exclusion/);
  assert.match(existingCoordinator, /configuredEnabled: current\.enabled/);
});

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-desktop-pet-e-transport-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));
const source = read("../src/lib/desktopPetETransport.ts");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  fileName: "desktopPetETransport.ts",
}).outputText;
const outputPath = join(tempDir, "desktopPetETransport.mjs");
writeFileSync(outputPath, output, "utf8");
const transport = await import(pathToFileURL(outputPath).href);

test("sync fingerprint changes only for visible config or snapshot revisions", () => {
  const base = {
    enabled: true,
    existingDesktopPetEnabled: false,
    config: { visible: true, language: "zh-CN", settings: {}, labels: {} },
    snapshot: { generation: 1, revision: 2 },
  };
  assert.equal(
    transport.desktopPetESyncFingerprint(base),
    transport.desktopPetESyncFingerprint(structuredClone(base)),
  );
  assert.notEqual(
    transport.desktopPetESyncFingerprint(base),
    transport.desktopPetESyncFingerprint({ ...base, snapshot: { generation: 1, revision: 3 } }),
  );
  assert.notEqual(
    transport.desktopPetESyncFingerprint(base),
    transport.desktopPetESyncFingerprint({ ...base, config: { ...base.config, visible: false } }),
  );
});
