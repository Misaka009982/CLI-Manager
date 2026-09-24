import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText)}`;
const { pairingRefreshDelay } = await import(moduleUrl(read("../src/features/settings/lib/webPairingLifecycle.ts")));

test("pairing refresh is scheduled at expiry only while a code is visible", () => {
  assert.equal(pairingRefreshDelay(null, 1_000, 900), null);
  assert.equal(pairingRefreshDelay("ABC123", null, 900), null);
  assert.equal(pairingRefreshDelay("ABC123", 1_000, 900), 150);
  assert.equal(pairingRefreshDelay("ABC123", 1_000, 1_050), 0);
});

test("desktop and browser surfaces wire expiry refresh and origin errors", () => {
  const settings = read("../src/features/settings/components/WebDeviceSettingsSection.tsx");
  assert.match(settings, /pairingRefreshDelay\(status\?\.pairingCode, status\?\.pairingExpiresAt/);
  assert.match(settings, /setTimeout\(\(\) => void refresh\(\)/);
  const views = read("../apps/web/src/views.tsx");
  assert.match(views, /code === "origin_forbidden" \|\| code === "origin_required"/);
  const messages = read("../apps/web/src/i18n.ts");
  assert.equal((messages.match(/pairingOriginMismatch:/g) ?? []).length, 2);
});
