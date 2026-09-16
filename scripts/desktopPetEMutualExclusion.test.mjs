import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Desktop Pet E and the existing pet are mutually exclusive without clearing preferences", () => {
  const settings = read("../src/shared/preferences/settingsStore.ts");
  const existingPage = read("../src/features/settings/components/pages/DesktopPetSettingsPage.tsx");
  const ePage = read("../src/features/settings/components/pages/DesktopPetESettingsPage.tsx");

  assert.match(settings, /desktopPetE:\s*\{ \.\.\.DEFAULT_DESKTOP_PET_E_SETTINGS \}/);
  assert.match(settings, /desktop_pet_mutual_exclusion/);
  assert.match(settings, /desktop_pet_e_mutual_exclusion/);
  assert.match(settings, /entries\.desktopPetE = \{ \.\.\.entries\.desktopPetE, enabled: false \}/);
  assert.match(existingPage, /disabled=\{desktopPetEEnabled && !desktopPet\.enabled\}/);
  assert.match(ePage, /const enableBlockedByExistingPet = desktopPet\.enabled && !desktopPetE\.enabled/);
  assert.doesNotMatch(settings, /desktopPet\s*=\s*DEFAULT_DESKTOP_PET_E_SETTINGS/);
});

test("Desktop Pet E settings remain local and the tab order is stable", () => {
  const settingsModal = read("../src/features/settings/api/SettingsModal.tsx");
  const syncSettings = read("../src/features/sync/lib/syncSettings.ts");
  const i18nZh = read("../src/shared/i18n/messages/desktop-pet.zh-CN.ts");
  const i18nEn = read("../src/shared/i18n/messages/desktop-pet.en-US.ts");

  assert.match(settingsModal, /"desktop-pet",\s*"desktop-pet-e",\s*"developer"/);
  assert.match(syncSettings, /desktopPet:\s*"excluded",\s*desktopPetE:\s*"excluded"/);
  assert.match(i18nZh, /"settings\.tabs\.desktopPetE\.label": "桌面宠物E"/);
  assert.match(i18nEn, /"settings\.tabs\.desktopPetE\.label": "Desktop Pet E"/);
});

test("the CLI frontend reuses the pet-e protocol source", () => {
  const frontendProtocol = read("../src/shared/lib/desktopPetE.ts");
  const petProtocol = read("../pet-e/src/bridge/protocol.ts");

  assert.equal(frontendProtocol.trim(), 'export * from "../../../pet-e/src/bridge/protocol";');
  assert.match(petProtocol, /DESKTOP_PET_E_PROTOCOL_VERSION = 1/);
  assert.match(petProtocol, /petId: string \| null/);
  assert.doesNotMatch(petProtocol, /DESKTOP_PET_E_THEMES|"clawd"|"calico"|"cloudling"/);
  assert.match(petProtocol, /instanceId: string/);
  assert.match(petProtocol, /generation: number/);
  assert.match(petProtocol, /revision: number/);
  assert.match(petProtocol, /actionId: string/);
});
