import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-desktop-pet-e-settings-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../pet-e/src/bridge/protocol.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "protocol.ts",
}).outputText;
const outputPath = join(tempDir, "protocol.mjs");
writeFileSync(outputPath, output, "utf8");
const protocol = await import(pathToFileURL(outputPath).href);

test("Desktop Pet E settings have local, deterministic defaults", () => {
  assert.deepEqual(protocol.normalizeDesktopPetESettings(undefined), {
    enabled: false,
    theme: "clawd",
    size: 100,
    position: null,
    lockPosition: false,
    alwaysOnTop: true,
    soundEnabled: true,
    showStatus: true,
    showCliLabel: true,
    showTaskArea: true,
    openOnHover: true,
    autoHideFullscreen: true,
    notificationsEnabled: true,
    agentInteractionEnabled: true,
  });
});

test("invalid theme, size, and position values are normalized", () => {
  assert.deepEqual(protocol.normalizeDesktopPetESettings({
    enabled: true,
    theme: "unknown",
    size: 203,
    position: { x: Number.NaN, y: 12 },
    soundEnabled: false,
  }), {
    ...protocol.DEFAULT_DESKTOP_PET_E_SETTINGS,
    enabled: true,
    size: 200,
    position: null,
    soundEnabled: false,
  });
  assert.equal(protocol.normalizeDesktopPetESize(103), 105);
  assert.deepEqual(protocol.normalizeDesktopPetESettings({
    position: { x: -100_001.4, y: 100_001.4 },
  }).position, { x: -100_000, y: 100_000 });
});

test("bridge envelopes reject unknown protocol versions and malformed revisions", () => {
  const valid = {
    protocolVersion: protocol.DESKTOP_PET_E_PROTOCOL_VERSION,
    instanceId: "instance-1",
    generation: 1,
    revision: 2,
    type: "ready",
    payload: { rendererReady: true },
  };
  assert.equal(protocol.isDesktopPetEEnvelope(valid), true);
  assert.equal(protocol.isDesktopPetEEnvelope({ ...valid, protocolVersion: 99 }), false);
  assert.equal(protocol.isDesktopPetEEnvelope({ ...valid, revision: -1 }), false);
  assert.equal(protocol.isDesktopPetEEnvelope({ ...valid, revision: 1.5 }), false);
});
