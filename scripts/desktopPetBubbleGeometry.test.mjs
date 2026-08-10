import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-desktop-pet-bubble-geometry-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/lib/desktopPetBubble.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "desktopPetBubble.ts",
}).outputText;
const outputPath = join(tempDir, "desktopPetBubble.mjs");
writeFileSync(outputPath, output, "utf8");
const bubble = await import(pathToFileURL(outputPath).href);

function geometry(anchor, overrides = {}) {
  return bubble.calculateDesktopPetBubbleGeometry({
    anchor,
    workArea: { x: 0, y: 0, width: 1_920, height: 1_080 },
    naturalWidth: 410,
    naturalHeight: 240,
    scaleFactor: 1,
    ...overrides,
  });
}

function assertInside(bounds, workArea) {
  assert.ok(bounds.x >= workArea.x);
  assert.ok(bounds.y >= workArea.y);
  assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width);
  assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height);
}

test("top and bottom corners choose the larger vertical work-area side", () => {
  const topLeft = geometry({ x: 20, y: 20, width: 190, height: 210 });
  const topRight = geometry({ x: 1_700, y: 20, width: 190, height: 210 });
  const bottomLeft = geometry({ x: 20, y: 850, width: 190, height: 210 });
  const bottomRight = geometry({ x: 1_700, y: 850, width: 190, height: 210 });

  assert.equal(topLeft.placement, "below");
  assert.equal(topRight.placement, "below");
  assert.equal(bottomLeft.placement, "above");
  assert.equal(bottomRight.placement, "above");
  for (const result of [topLeft, topRight, bottomLeft, bottomRight]) {
    assertInside(result.bounds, { x: 0, y: 0, width: 1_920, height: 1_080 });
  }
});

test("geometry supports negative-coordinate monitors and non-integer DPI", () => {
  for (const scaleFactor of [1, 1.25, 1.5]) {
    const workArea = {
      x: -1_920 * scaleFactor,
      y: -120 * scaleFactor,
      width: 1_920 * scaleFactor,
      height: 1_080 * scaleFactor,
    };
    const result = geometry({
      x: -1_900 * scaleFactor,
      y: 700 * scaleFactor,
      width: 190 * scaleFactor,
      height: 210 * scaleFactor,
    }, { workArea, scaleFactor, naturalHeight: 320 });

    assertInside(result.bounds, workArea);
    assert.ok(Number.isFinite(result.arrowOffset));
    assert.ok(result.logicalWidth > 0);
    assert.ok(result.logicalHeight > 0);
  }
});

test("long content flips to an inward side when it exposes more reachable area", () => {
  const result = geometry(
    { x: 305, y: 195, width: 190, height: 210 },
    {
      workArea: { x: 0, y: 0, width: 800, height: 600 },
      naturalHeight: 500,
    },
  );

  assert.equal(result.placement, "left");
  assert.ok(result.logicalHeight >= 500);
  assert.ok(result.logicalWidth >= bubble.DESKTOP_PET_BUBBLE_MIN_WIDTH);
  assertInside(result.bounds, { x: 0, y: 0, width: 800, height: 600 });
});

test("narrow work areas shrink width without moving the pet anchor", () => {
  const anchor = { x: 80, y: 300, width: 140, height: 180 };
  const copy = structuredClone(anchor);
  const result = geometry(anchor, {
    workArea: { x: 0, y: 0, width: 300, height: 800 },
    naturalWidth: 800,
    naturalHeight: 260,
  });

  assert.deepEqual(anchor, copy);
  assert.ok(result.logicalWidth <= 300);
  assertInside(result.bounds, { x: 0, y: 0, width: 300, height: 800 });
});

test("over-height content returns a bounded viewport instead of clipping the workspace", () => {
  const workArea = { x: 0, y: 0, width: 700, height: 500 };
  const result = geometry(
    { x: 20, y: 140, width: 190, height: 210 },
    { workArea, naturalHeight: 2_000 },
  );

  assert.ok(result.logicalHeight < 2_000);
  assert.ok(result.logicalHeight > 0);
  assertInside(result.bounds, workArea);
});

test("missing or invalid monitor data produces finite safe fallback bounds", () => {
  const result = bubble.calculateDesktopPetBubbleGeometry({
    anchor: { x: Number.NaN, y: -20, width: 0, height: Number.POSITIVE_INFINITY },
    workArea: null,
    naturalWidth: Number.NaN,
    naturalHeight: Number.POSITIVE_INFINITY,
    scaleFactor: 0,
  });

  for (const value of Object.values(result.bounds)) assert.ok(Number.isFinite(value));
  assert.ok(result.bounds.width > 0);
  assert.ok(result.bounds.height > 0);
  assert.equal(result.placement, "above");
});

test("hit regions clip to the viewport and round outward at the current DPI", () => {
  const result = bubble.normalizeDesktopPetHitRegions([
    { x: -1.2, y: 2.2, width: 10, height: 5 },
    { x: 98.5, y: 48.5, width: 10, height: 10 },
    { x: 200, y: 200, width: 10, height: 10 },
    { x: Number.NaN, y: 0, width: 10, height: 10 },
  ], 100, 50, 1.5);

  assert.deepEqual(result, [
    { x: 0, y: 3, width: 14, height: 8 },
    { x: 147, y: 72, width: 3, height: 3 },
  ]);
});

test("hit region count is bounded", () => {
  const rects = Array.from({ length: 100 }, (_, index) => ({
    x: index,
    y: index,
    width: 1,
    height: 1,
  }));
  assert.equal(
    bubble.normalizeDesktopPetHitRegions(rects, 200, 200, 1).length,
    bubble.DESKTOP_PET_MAX_HIT_REGIONS,
  );
  assert.deepEqual(bubble.normalizeDesktopPetHitRegions(rects, 200, 200, 1, 0), []);
});

test("frame task runner coalesces bursts and applies a trailing final value", () => {
  let nextHandle = 1;
  let frameCallback = null;
  let timerCallback = null;
  let frameRequests = 0;
  let cancelledFrames = 0;
  const applied = [];
  const runner = bubble.createDesktopPetLatestFrameTaskRunner(
    (value) => applied.push(value),
    {
      requestFrame(callback) {
        frameRequests += 1;
        frameCallback = callback;
        return nextHandle++;
      },
      cancelFrame() {
        cancelledFrames += 1;
        frameCallback = null;
      },
      setTimer(callback) {
        timerCallback = callback;
        return nextHandle++;
      },
      clearTimer() {
        timerCallback = null;
      },
    },
    80,
  );

  runner.schedule(1);
  runner.schedule(2);
  runner.schedule(3);
  assert.equal(frameRequests, 1);
  frameCallback();
  assert.deepEqual(applied, [3]);
  timerCallback();
  assert.deepEqual(applied, [3]);

  runner.schedule(4);
  assert.equal(frameRequests, 2);
  timerCallback();
  assert.deepEqual(applied, [3, 4]);
  assert.equal(cancelledFrames, 1);

  runner.schedule(5);
  runner.flush();
  assert.deepEqual(applied, [3, 4, 5]);
  runner.dispose();
  runner.schedule(6);
  assert.deepEqual(applied, [3, 4, 5]);
});
