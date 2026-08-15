import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("宠物E只消费已校验的 Codex 宠物包", () => {
  const protocol = read("../src/bridge/protocol.ts");
  const coordinator = read("../../src/hooks/useDesktopPetECoordinator.ts");
  const settings = read("../../src/components/settings/pages/DesktopPetESettingsPage.tsx");
  assert.match(protocol, /petId: string \| null/);
  assert.match(protocol, /spritePath: string/);
  assert.match(coordinator, /desktop_pet_list_installed/);
  assert.match(coordinator, /format === "codex"/);
  assert.match(coordinator, /manifest\.engine !== "codex-sprite"/);
  assert.match(settings, /desktop_pet_list_installed/);
  assert.doesNotMatch(protocol, /DESKTOP_PET_E_THEMES|clawd|calico|cloudling/);
});

test("sprite asset never exposes an absolute path to the renderer", () => {
  const main = read("../src/main.ts");
  assert.match(main, /pet-e-asset/);
  assert.match(main, /spritePath: `\$\{ASSET_SCHEME\}:\/\/sprite\/current/);
  assert.match(main, /path\.extname\(resolved\)\.toLowerCase\(\) !== "\.webp"/);
  assert.match(main, /MAX_SPRITE_BYTES/);
  assert.match(main, /url\.hostname !== "sprite"/);
});
