import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebTerminalFrames } from "./webTerminalRenderQueue.ts";
const frame = (sequence, extra = {}) => ({ sequence, kind: "output", data: "YQ==", cols: 80, rows: 24, replayBatchEnd: false, ...extra });
test("fragments are atomic and a reconnect restart replaces partial bytes", () => {
  const frames = createWebTerminalFrames();
  assert.deepEqual(frames.accept({ sequence: 1, frames: [frame(9, { sequenceEnd: false })] }), []);
  const result = frames.accept({ sequence: 2, frames: [frame(9, { sequenceStart: true, data: "Yg==" })] });
  assert.equal(result.length, 1);
  assert.equal(result[0].frame.data, "Yg==");
  assert.deepEqual(frames.accept({ sequence: 3, frames: [frame(9)] }), []);
});
test("replay is reset once and retains original grids until the final batch", () => {
  const frames = createWebTerminalFrames();
  assert.deepEqual(frames.accept({ sequence: 1, frames: [frame(0, { kind: "reset", data: "" }), frame(1, { kind: "replay", cols: 120 })] }), []);
  assert.equal(frames.pending(), true);
  const rendered = frames.accept({ sequence: 2, frames: [frame(2, { kind: "replay", cols: 60, replayBatchEnd: true })] });
  assert.deepEqual(rendered.map((item) => [item.reset, item.frame.cols]), [[true, 120], [false, 60]]);
  assert.equal(frames.pending(), false);
});
test("an unfinished frame cannot bypass the bounded render memory budget", () => {
  const frames = createWebTerminalFrames();
  const fragment = frame(7, { sequenceEnd: false, data: "YQ==".repeat(256 * 1024) });
  assert.throws(() => {
    for (let sequence = 1; sequence <= 25; sequence++) frames.accept({ sequence, frames: [fragment] });
  }, /terminal_buffer_full/);
});
