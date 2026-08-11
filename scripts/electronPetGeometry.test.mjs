import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeShapeRects } = require("../electron-pet/app/geometry.cjs");

test("Electron hit shapes convert logical rectangles to physical pixels", () => {
  const result = normalizeShapeRects([
    { x: -1.2, y: 2.2, width: 10, height: 5 },
    { x: 98.5, y: 48.5, width: 10, height: 10 },
    { x: 200, y: 200, width: 10, height: 10 },
    { x: Number.NaN, y: 0, width: 10, height: 10 },
  ], { width: 100, height: 50 }, 1.5);

  assert.deepEqual(result, [
    { x: 0, y: 3, width: 14, height: 8 },
    { x: 147, y: 72, width: 3, height: 3 },
  ]);
});

test("Electron hit shapes round outward at common fractional DPI scales", () => {
  const rect = [{ x: 10, y: 20, width: 30, height: 40 }];
  const bounds = { width: 100, height: 100 };

  assert.deepEqual(
    normalizeShapeRects(rect, bounds, 1.25),
    [{ x: 12, y: 25, width: 38, height: 50 }],
  );
  assert.deepEqual(
    normalizeShapeRects(rect, bounds, 1.5),
    [{ x: 15, y: 30, width: 45, height: 60 }],
  );
});

test("Electron hit shapes fall back to unscaled coordinates for invalid DPI", () => {
  assert.deepEqual(
    normalizeShapeRects(
      [{ x: 1.2, y: 2.2, width: 3, height: 4 }],
      { width: 100, height: 50 },
      0,
    ),
    [{ x: 1, y: 2, width: 4, height: 5 }],
  );
});
