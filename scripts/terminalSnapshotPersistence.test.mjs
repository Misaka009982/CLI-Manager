import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/features/terminal/api/sessionSnapshotPersistence.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("snapshots.ts", source, ts.ScriptTarget.Latest, true);
const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join("\n");
const compiled = ts.transpileModule(`${body}\nexports.tick = flushDirtySnapshots;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function harness(save = async () => {}) {
  const exports = {}, timers = new Set(), updates = [], errors = [], saves = [];
  const state = {
    sessions: [],
    updateSessionTerminalSnapshot(id, text) { updates.push({ id, text }); },
  };
  runInNewContext(compiled, {
    exports, AbortController,
    useTerminalStore: { getState: () => state },
    useSessionStore: { getState: () => ({ saveSessions: async rows => { saves.push(rows); await save(rows); } }) },
    logError: (...args) => errors.push(args),
    setInterval: callback => { timers.add(callback); return callback; },
    clearInterval: timer => timers.delete(timer),
  });
  return { ...exports, timers, updates, errors, saves };
}

test("idle sources do not serialize and unregister stops the timer", async () => {
  const h = harness();
  let count = 0;
  assert.equal(h.timers.size, 0);
  const stop = h.registerTerminalSnapshotSource("a", () => { count++; return "text"; });
  assert.equal(h.timers.size, 1);
  await h.tick();
  assert.equal(count, 0);
  stop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.terminalSnapshotDiagnostics().sources, 0);
});

test("full checkpoint and the existing 2000-line persisted tail remain unchanged", async () => {
  const h = harness(), checkpoints = [];
  const full = Array.from({ length: 5001 }, (_, i) => `line-${i}`).join("\n");
  h.registerTerminalSnapshotSource("a", () => full, async text => { checkpoints.push(text); });
  h.markTerminalSnapshotDirty("a");
  await h.tick();
  assert.deepEqual(checkpoints, [full]);
  assert.equal(h.updates[0].text, full.split("\n").slice(-2000).join("\n"));
  assert.equal(h.saves.length, 1);
});

test("slow serialization coalesces periodic ticks and preserves newly dirty output", async () => {
  const h = harness(), wait = deferred();
  let count = 0;
  h.registerTerminalSnapshotSource("a", () => { count++; return count === 1 ? wait.promise : "latest"; });
  h.markTerminalSnapshotDirty("a");
  const first = h.tick();
  await settle();
  const ticks = Array.from({ length: 20 }, () => h.tick());
  h.markTerminalSnapshotDirty("a");
  await settle();
  assert.equal(count, 1);
  assert.equal(h.terminalSnapshotDiagnostics().flushing, true);
  wait.resolve("first");
  await Promise.all([first, ...ticks]);
  assert.equal(h.terminalSnapshotDiagnostics().dirtySources, 1);
  await h.tick();
  assert.equal(count, 2);
  assert.equal(h.updates.at(-1).text, "latest");
});

test("exit/handoff during a periodic flush waits for a fresh forced pass", async () => {
  const h = harness(), firstBarrier = deferred(), secondBarrier = deferred();
  let count = 0, completed = false;
  h.registerTerminalSnapshotSource("a", () => ++count === 1 ? firstBarrier.promise : secondBarrier.promise);
  h.markTerminalSnapshotDirty("a");
  const tick = h.tick();
  await settle();
  const force = h.flushTerminalSnapshotsNow().then(() => { completed = true; });
  const duplicate = h.flushTerminalSnapshotsNow();
  firstBarrier.resolve("before-exit");
  await settle();
  assert.equal(count, 2);
  assert.equal(completed, false);
  secondBarrier.resolve("final");
  await Promise.all([tick, force, duplicate]);
  assert.equal(h.updates.at(-1).text, "final");
  assert.equal(count, 2);
  assert.equal(h.terminalSnapshotDiagnostics().flushing, false);
});

test("a force request before the queued flush starts is not lost", async () => {
  const h = harness();
  let count = 0;
  h.registerTerminalSnapshotSource("clean", () => { count++; return "final"; });
  await Promise.all([h.tick(), h.flushTerminalSnapshotsNow()]);
  assert.equal(count, 1);
});

test("force requests at every microtask boundary cannot miss the final state", async () => {
  for (let offset = 0; offset < 24; offset++) {
    const h = harness();
    let text = "before";
    h.registerTerminalSnapshotSource("a", () => text);
    h.markTerminalSnapshotDirty("a");
    const initial = h.tick();
    for (let turn = 0; turn < offset; turn++) await Promise.resolve();
    text = "final";
    await Promise.all([initial, h.flushTerminalSnapshotsNow()]);
    assert.equal(h.updates.at(-1).text, "final", `arrival at microtask ${offset}`);
  }
});

test("source replacement and old cleanup cannot delete or publish over the new source", async () => {
  const h = harness(), wait = deferred(), checkpoints = [];
  const oldStop = h.registerTerminalSnapshotSource("same", () => wait.promise, async () => checkpoints.push("old"));
  h.markTerminalSnapshotDirty("same");
  const tick = h.tick();
  await settle();
  const newStop = h.registerTerminalSnapshotSource("same", () => "new");
  oldStop();
  assert.equal(h.terminalSnapshotDiagnostics().sources, 1);
  wait.resolve("old");
  await tick;
  assert.deepEqual(checkpoints, []);
  assert.equal(h.updates.length, 0);
  await h.flushTerminalSnapshotsNow();
  assert.equal(h.updates[0].text, "new");
  newStop();
  assert.equal(h.timers.size, 0);
});

test("closing during checkpoint skips stale store updates and proceeds to the next terminal", async () => {
  const h = harness(), wait = deferred();
  const stop = h.registerTerminalSnapshotSource("closed", () => "stale", () => wait.promise);
  h.registerTerminalSnapshotSource("live", () => "current");
  const flush = h.flushTerminalSnapshotsNow();
  await settle();
  stop();
  wait.resolve();
  await flush;
  assert.deepEqual(h.updates.map(item => item.id), ["live"]);
});

test("serialization and checkpoint failures retry without blocking other terminals", async () => {
  const h = harness();
  let serializeCount = 0, checkpointCount = 0;
  h.registerTerminalSnapshotSource("serialize", () => {
    if (++serializeCount === 1) throw new Error("serialize failed");
    return "ok";
  });
  h.registerTerminalSnapshotSource("checkpoint", () => "ok", async () => {
    if (++checkpointCount === 1) throw new Error("checkpoint failed");
  });
  await h.flushTerminalSnapshotsNow();
  assert.equal(h.errors.length, 2);
  assert.equal(h.terminalSnapshotDiagnostics().dirtySources, 2);
  await h.tick();
  assert.equal(h.terminalSnapshotDiagnostics().dirtySources, 0);
  assert.equal(serializeCount, 2);
  assert.equal(checkpointCount, 2);
});

test("persistence failures mark saved sources dirty and retry without requiring new output", async () => {
  let attempts = 0;
  const h = harness(async () => { if (++attempts === 1) throw new Error("disk failed"); });
  h.registerTerminalSnapshotSource("a", () => "data");
  await h.flushTerminalSnapshotsNow();
  assert.equal(h.terminalSnapshotDiagnostics().dirtySources, 1);
  await h.tick();
  assert.equal(attempts, 2);
  assert.equal(h.terminalSnapshotDiagnostics().dirtySources, 0);
});

test("disposed xterm write barriers cancel, release the flight, and ignore late callbacks", async () => {
  const h = harness();
  let callback, serialized = 0;
  const stop = h.registerTerminalSnapshotSource("a", signal => h.serializeTerminalAfterWrite(
    { write: (_text, done) => { callback = done; } },
    () => { serialized++; return "old"; }, signal,
  ));
  const flight = h.flushTerminalSnapshotsNow();
  await settle();
  stop();
  await flight;
  callback();
  assert.equal(serialized, 0);
  assert.equal(h.updates.length, 0);
  assert.equal(h.errors.length, 0);
  assert.equal(h.terminalSnapshotDiagnostics().flushing, false);
  h.registerTerminalSnapshotSource("next", () => "next");
  await h.flushTerminalSnapshotsNow();
  assert.equal(h.updates[0].text, "next");
});

test("write barrier catches serializer exceptions instead of hanging the flush", async () => {
  const h = harness(), signal = new AbortController().signal;
  let done;
  const pending = h.serializeTerminalAfterWrite({ write: (_text, callback) => { done = callback; } },
    () => { throw new Error("serialize error"); }, signal);
  const rejected = assert.rejects(pending, /serialize error/);
  done();
  await rejected;
});

test("snapshot diagnostics and cancellable serializer are connected to production callers", () => {
  const controller = readFileSync(new URL("../src/features/terminal/hooks/useXTermController.ts", import.meta.url), "utf8");
  const diagnostics = readFileSync(new URL("../src/features/terminal/api/runtimeDiagnostics.ts", import.meta.url), "utf8");
  assert.match(controller, /serializeAfterWriteBarrier = \(signal: AbortSignal\) => serializeTerminalAfterWrite/);
  assert.match(controller, /registerTerminalSnapshotSource\(\s*sessionId,\s*serializeAfterWriteBarrier/);
  assert.match(diagnostics, /snapshots: terminalSnapshotDiagnostics\(\)/);
});
