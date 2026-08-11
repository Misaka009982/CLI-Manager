import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-desktop-pet-companion-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/lib/desktopPetCompanion.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "desktopPetCompanion.ts",
}).outputText;
const outputPath = join(tempDir, "desktopPetCompanion.mjs");
writeFileSync(outputPath, output, "utf8");
const companion = await import(pathToFileURL(outputPath).href);

test("Electron companion is requested only on Windows", () => {
  assert.equal(companion.shouldUseElectronDesktopPet("electron", "windows"), true);
  assert.equal(companion.shouldUseElectronDesktopPet("electron", "macos"), false);
  assert.equal(companion.shouldUseElectronDesktopPet("electron", "linux"), false);
  assert.equal(companion.shouldUseElectronDesktopPet("electron", "unknown"), false);
  assert.equal(companion.shouldUseElectronDesktopPet("tauri", "windows"), false);
});

test("Tauri surfaces stay hidden while Electron is selected", () => {
  assert.equal(companion.shouldShowTauriDesktopPetSurface(true, true, false), false);
  assert.equal(companion.shouldShowTauriDesktopPetSurface(true, true, true), false);
});

test("Tauri surfaces wait for Electron to stop after switching back", () => {
  assert.equal(companion.shouldShowTauriDesktopPetSurface(true, false, true), false);
  assert.equal(companion.shouldShowTauriDesktopPetSurface(true, false, false), true);
});

test("Tauri surfaces respect their shared visibility policy", () => {
  assert.equal(companion.shouldShowTauriDesktopPetSurface(false, false, false), false);
});
