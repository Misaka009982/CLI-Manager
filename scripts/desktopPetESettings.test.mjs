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
const settingsPageSource = readFileSync(
  new URL("../src/features/settings/components/pages/DesktopPetESettingsPage.tsx", import.meta.url),
  "utf8",
);
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
const preferencesSource = readFileSync(new URL("../src/shared/preferences/desktopPetEPreferences.ts", import.meta.url), "utf8");
const preferencesOutput = ts.transpileModule(preferencesSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText.replaceAll('from "../lib/desktopPetE"', 'from "./protocol.mjs"');
const preferencesPath = join(tempDir, "preferences.mjs");
writeFileSync(preferencesPath, preferencesOutput, "utf8");
const preferences = await import(pathToFileURL(preferencesPath).href);

test("折叠偏好迁移独立保留默认值且不混入桥接设置", () => {
  for (const value of [undefined, null, "invalid", { petPicker: "yes" }]) {
    assert.deepEqual(preferences.migrateDesktopPetESettingsSectionsExpanded(value), { petPicker: false });
  }
  assert.deepEqual(preferences.migrateDesktopPetESettingsSectionsExpanded({ petPicker: true, unknown: true }), { petPicker: true });
  assert.deepEqual(preferences.migrateDesktopPetESettings(undefined), protocol.DEFAULT_DESKTOP_PET_E_SETTINGS);
  assert.equal("petPicker" in preferences.migrateDesktopPetESettings({ petPicker: true }), false);
});

test("加载旧双开设置时只停用宠物E并保留样式偏好", () => {
  const entries = {
    desktopPet: { enabled: true },
    desktopPetE: { ...protocol.DEFAULT_DESKTOP_PET_E_SETTINGS, enabled: true, size: 140, petId: "codex.kuromuse" },
    desktopPetESettingsSectionsExpanded: { petPicker: true },
  };
  const persisted = [];
  preferences.applyDesktopPetEPreferences(entries, (key, value) => persisted.push({ key, value }));
  assert.equal(entries.desktopPet.enabled, true);
  assert.equal(entries.desktopPetE.enabled, false);
  assert.equal(entries.desktopPetE.size, 140);
  assert.equal(entries.desktopPetE.petId, "codex.kuromuse");
  assert.deepEqual(entries.desktopPetESettingsSectionsExpanded, { petPicker: true });
  assert.deepEqual(persisted, [{ key: "desktopPetE", value: entries.desktopPetE }]);
  preferences.applyDesktopPetEPreferences(entries, (key, value) => persisted.push({ key, value }));
  assert.equal(persisted.length, 1, "重复加载不重复写入互斥修正");
});

test("独立偏好入口在写盘前检查双向互斥并保留已有偏好", () => {
  const settings = {
    desktopPet: { enabled: true },
    desktopPetE: { ...protocol.DEFAULT_DESKTOP_PET_E_SETTINGS, petId: "codex.kuromuse", size: 130 },
  };
  assert.throws(() => preferences.prepareDesktopPetSettingUpdate("desktopPetE", { enabled: true }, settings), /desktop_pet_e_mutual_exclusion/);
  assert.equal(settings.desktopPetE.enabled, false);
  const enabled = preferences.prepareDesktopPetSettingUpdate("desktopPetE", { enabled: true }, {
    ...settings, desktopPet: { enabled: false },
  });
  assert.equal(enabled.petId, "codex.kuromuse");
  assert.equal(enabled.size, 130);
  assert.throws(() => preferences.prepareDesktopPetSettingUpdate("desktopPet", { enabled: true }, {
    ...settings, desktopPetE: enabled,
  }), /desktop_pet_mutual_exclusion/);
  const disabled = { enabled: false };
  assert.equal(preferences.prepareDesktopPetSettingUpdate("desktopPet", disabled, { ...settings, desktopPetE: enabled }), disabled);
  const unrelated = { value: "unchanged" };
  assert.equal(preferences.prepareDesktopPetSettingUpdate("theme", unrelated, settings), unrelated);
});

test("Desktop Pet E settings have local, deterministic defaults", () => {
  assert.deepEqual(protocol.normalizeDesktopPetESettings(undefined), {
    enabled: false,
    petId: null,
    size: 100,
    position: null,
    lockPosition: false,
    clickThroughEnabled: false,
    alwaysOnTop: true,
    soundEnabled: true,
    showStatusLabel: false,
    showCliLabel: true,
    showTaskArea: true,
    openOnHover: true,
    autoHideFullscreen: true,
    notificationsEnabled: true,
    agentInteractionEnabled: true,
  });
});

test("click-through defaults off so native drag regions receive mouse input", () => {
  const mainSource = readFileSync(new URL("../pet-e/src/main.ts", import.meta.url), "utf8");
  assert.match(settingsPageSource, /desktopPetE\.settings\.clickThrough/);
  assert.match(settingsPageSource, /checked=\{desktopPetE\.clickThroughEnabled\}/);
  assert.match(mainSource, /latestConfig\?\.settings\.clickThroughEnabled === false/);
  assert.match(mainSource, /if \(config\.visible\) \{[\s\S]*setWindowMouseInteractive\(false\);/);
});

test("invalid pet IDs, size, and position values are normalized", () => {
  assert.deepEqual(protocol.normalizeDesktopPetESettings({
    enabled: true,
    petId: "",
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
  assert.equal(protocol.normalizeDesktopPetESettings({ petId: " codex.kuromuse " }).petId, "codex.kuromuse");
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

test("pet selection uses validated Codex artwork buttons instead of a text select", () => {
  assert.match(settingsPageSource, /pet\.format === "codex" && pet\.manifest\.engine === "codex-sprite"/);
  assert.match(settingsPageSource, /<SimpleGrid/);
  assert.match(settingsPageSource, /<PetArtwork/);
  assert.match(settingsPageSource, /width=\{88\}/);
  assert.match(settingsPageSource, /animated=\{false\}/);
  assert.match(settingsPageSource, /aria-pressed=\{selected\}/);
  assert.match(settingsPageSource, /selectingPetId/);
  assert.match(settingsPageSource, /selectionInFlightRef/);
  assert.match(settingsPageSource, /if \(preferredId\) selectPet\(preferredId\);/);
  assert.match(settingsPageSource, /setPreviewFailed\(false\);\s*\}, \[pet\]\);/);
  assert.match(
    settingsPageSource,
    /if \(petsLoading \|\| codexPets\.length === 0 \|\| desktopPetE\.petId\) return;/,
  );
  // 用单词边界：折叠功能新增的 <SelectedPetSummary> 不应被当成下拉框误判。
  assert.doesNotMatch(settingsPageSource, /<Select\b/);
});
