import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../apps/web/src/terminalDisplay.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { DEFAULT_DISPLAY, normalizeDisplay, readDisplay, stepDisplaySize } =
  await import(`data:text/javascript,${encodeURIComponent(javascript)}`);

test("legacy settings retain mode and manual font while discarding region limits", () => {
  for (const mode of ["manual", "width", "contain"]) {
    const result = normalizeDisplay({ mode, fontSize: 22, width: 75, height: 90 });
    assert.deepEqual(result, { mode: mode === "manual" ? "manual" : "width", fontSize: 22, zoom: 100 });
  }
  assert.deepEqual(normalizeDisplay(null), DEFAULT_DISPLAY);
});

test("size steps adjust actual font consistently regardless of saved mirror mode", () => {
  for (const mode of ["manual", "width", "contain"]) {
    const initial = { ...DEFAULT_DISPLAY, mode, fontSize: 22, zoom: 150 };
    const increased = normalizeDisplay({ ...initial, ...stepDisplaySize(initial, 1, 10) });
    assert.equal(increased.mode, "manual");
    assert.equal(increased.fontSize, 11);
    assert.equal(increased.zoom, 150);
    assert.equal(stepDisplaySize(increased, -1, 11).fontSize, 10);
  }
});

test("size limits and invalid saved values are normalized", () => {
  assert.equal(normalizeDisplay({ zoom: 999 }).zoom, 300);
  assert.equal(normalizeDisplay({ zoom: -1 }).zoom, 25);
  assert.equal(normalizeDisplay({ zoom: NaN }).zoom, 100);
  assert.equal(normalizeDisplay({ zoom: "150" }).zoom, 100);
  assert.equal(normalizeDisplay({ fontSize: 999 }).fontSize, 36);
  assert.equal(normalizeDisplay({ fontSize: -1 }).fontSize, 1);
});

test("font controls start from rendered size and respect limits", () => {
  assert.equal(stepDisplaySize(DEFAULT_DISPLAY, 1, 4).fontSize, 5);
  assert.equal(stepDisplaySize(DEFAULT_DISPLAY, -1, 1).fontSize, 1);
  assert.equal(stepDisplaySize(DEFAULT_DISPLAY, 1, 36).fontSize, 36);
});

test("browser settings round-trip and recover from invalid storage", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let saved = JSON.stringify({ ...DEFAULT_DISPLAY, mode: "width", zoom: 150 });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => saved } });
  try {
    assert.equal(readDisplay().zoom, 150);
    assert.equal(readDisplay().mode, "width");
    saved = JSON.stringify({ mode: "manual", fontSize: 18, zoom: 100, width: 40, height: 50 });
    assert.deepEqual(readDisplay(), { mode: "manual", fontSize: 18, zoom: 100 });
    saved = "broken JSON";
    assert.deepEqual(readDisplay(), DEFAULT_DISPLAY);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
});
