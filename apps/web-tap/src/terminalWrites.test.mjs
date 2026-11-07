import assert from "node:assert/strict";
import { test } from "node:test";
import { createTerminalWrites } from "./terminalWrites.ts";

function clock(t, visible = true) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const document = new EventTarget(); document.visibilityState = visible ? "visible" : "hidden";
  const frames = new Map(); let next = 0;
  for (const [key, value] of Object.entries({ document,
    requestAnimationFrame: (callback) => { frames.set(++next, callback); return next; },
    cancelAnimationFrame: (id) => frames.delete(id),
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  return { document, frames, frame() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)); } };
}
test("one shared frame starts only one terminal batch, preferring the visible session", (t) => {
  const c = clock(t); const queue = createTerminalWrites(); const writes = [];
  queue.request({ token: Symbol(), isVisible: () => false, start: () => writes.push("hidden") });
  queue.request({ token: Symbol(), isVisible: () => true, start: () => writes.push("visible") });
  c.frame(); assert.deepEqual(writes, ["visible"]);
  c.frame(); assert.deepEqual(writes, ["visible", "hidden"]);
});
test("a continuously ready visible terminal yields after three batches", (t) => {
  const c = clock(t); const queue = createTerminalWrites(); const writes = [];
  const visible = { token: Symbol(), isVisible: () => true, start() {
    writes.push("visible"); if (writes.length < 5) queue.request(visible);
  } };
  queue.request({ token: Symbol(), isVisible: () => false, start: () => writes.push("hidden") });
  queue.request(visible);
  for (let index = 0; index < 5; index++) c.frame();
  queue.cancel(visible.token);
  assert.deepEqual(writes, ["visible", "visible", "visible", "hidden", "visible"]);
});
test("hidden output progresses by timer, visibility reschedules, and canceled work never starts", (t) => {
  const c = clock(t, false); const queue = createTerminalWrites(); const writes = [];
  const job = { token: Symbol(), isVisible: () => true, start: () => writes.push("done") };
  queue.request(job); assert.equal(c.frames.size, 0);
  t.mock.timers.tick(100); assert.deepEqual(writes, ["done"]);
  queue.request(job); c.document.visibilityState = "visible"; c.document.dispatchEvent(new Event("visibilitychange"));
  c.frame(); assert.deepEqual(writes, ["done", "done"]);
  queue.request(job); queue.cancel(job.token); c.frame(); t.mock.timers.tick(500);
  assert.deepEqual(writes, ["done", "done"]);
});
