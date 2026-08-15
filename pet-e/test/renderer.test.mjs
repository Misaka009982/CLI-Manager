import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("renderer keeps the task area collapsed until an explicit interaction", () => {
  const source = read("../src/renderer/app.ts");
  assert.match(source, /let expandedColor: DesktopPetEColor \| null = null/);
  assert.match(source, /firstAvailableColor\(snapshot\)/);
  assert.match(source, /data-command=\"close-pet\"/);
  assert.match(source, /kind: "open-settings"/);
  assert.match(source, /config\.settings\.openOnHover/);
  assert.match(source, /config\?\.settings\.agentInteractionEnabled !== false/);
});

test("renderer preserves drafts and exposes retry after a rejected action", () => {
  const source = read("../src/renderer/app.ts");
  assert.match(source, /const drafts = new Map/);
  assert.match(source, /const submissionErrors = new Map/);
  assert.match(source, /result\.confirmed/);
  assert.match(source, /!result\.accepted \|\| result\.error/);
  assert.match(source, /desktopPetE\.renderer\.retry/);
  assert.match(source, /pendingAction\.id/);
});

test("renderer uses the strict CSP-compatible sprite class contract", () => {
  const app = read("../src/renderer/app.ts");
  const html = read("../src/renderer/index.html");
  const css = read("../src/renderer/styles.css");
  assert.doesNotMatch(app, /style=\"/);
  assert.match(app, /sprite-row-\$\{state\.row\}/);
  assert.match(css, /sprite-row-10/);
  assert.match(html, /style-src pet-e-app:/);
  assert.doesNotMatch(html, /unsafe-inline/);
});
