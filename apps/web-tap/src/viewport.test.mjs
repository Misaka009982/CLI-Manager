import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateViewport } from "./viewport.ts";

test("keyboard translation accounts for the browser's existing vertical pan", () => {
  assert.deepEqual(calculateViewport(844, 500, 100, 1), { top: 100, height: 500, keyboard: 244, open: true });
  assert.deepEqual(calculateViewport(844, 844, 0, 1), { top: 0, height: 844, keyboard: 0, open: false });
});
test("pinch zoom and the small hardware-keyboard toolbar must not translate the workspace", () => {
  assert.deepEqual(calculateViewport(844, 500, 100, 2), { top: 100, height: 500, keyboard: 0, open: false });
  assert.equal(calculateViewport(844, 800, 0, 1).open, false);
  assert.equal(calculateViewport(844, 844, 40, 1).keyboard, 0);
});
