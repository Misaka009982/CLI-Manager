import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-desktop-pet-settings-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/lib/desktopPetSettings.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "desktopPetSettings.ts",
}).outputText;
const outputPath = join(tempDir, "desktopPetSettings.mjs");
writeFileSync(outputPath, output, "utf8");
const desktopPetSettings = await import(pathToFileURL(outputPath).href);

function createSettings() {
  return {
    enabled: true,
    runtime: "electron",
    profiles: {
      tauri: {
        petId: "tauri-pet",
        alwaysOnTop: true,
        agentSessionsOnly: true,
        size: 80,
        showActionMenu: true,
        openOnHover: true,
        workingBounceEnabled: false,
        workingBounceDistancePx: 2,
        showStatus: true,
        showSessionName: false,
        autoHideFullscreen: true,
        lockPosition: false,
        position: { x: 10, y: 20 },
      },
      electron: {
        petId: "electron-pet",
        alwaysOnTop: false,
        agentSessionsOnly: false,
        size: 125,
        showActionMenu: false,
        openOnHover: false,
        workingBounceEnabled: true,
        workingBounceDistancePx: 5,
        showStatus: false,
        showSessionName: true,
        autoHideFullscreen: false,
        lockPosition: true,
        position: { x: 300, y: 400 },
      },
    },
  };
}

test("runtime resolution returns only the selected desktop pet profile", () => {
  const settings = createSettings();
  const tauri = desktopPetSettings.resolveDesktopPetSettings(settings, "tauri");
  const electron = desktopPetSettings.resolveDesktopPetSettings(settings, "electron");

  assert.equal(tauri.runtime, "tauri");
  assert.equal(tauri.petId, "tauri-pet");
  assert.equal(tauri.size, 80);
  assert.deepEqual(tauri.position, { x: 10, y: 20 });
  assert.equal(electron.runtime, "electron");
  assert.equal(electron.petId, "electron-pet");
  assert.equal(electron.size, 125);
  assert.deepEqual(electron.position, { x: 300, y: 400 });
});

test("patching Electron settings leaves the Tauri profile unchanged", () => {
  const settings = createSettings();
  const next = desktopPetSettings.patchDesktopPetRuntimeProfile(settings, "electron", {
    size: 140,
    position: { x: 500, y: 600 },
  });

  assert.equal(next.profiles.electron.size, 140);
  assert.deepEqual(next.profiles.electron.position, { x: 500, y: 600 });
  assert.strictEqual(next.profiles.tauri, settings.profiles.tauri);
  assert.equal(settings.profiles.electron.size, 125);
  assert.deepEqual(settings.profiles.electron.position, { x: 300, y: 400 });
});
