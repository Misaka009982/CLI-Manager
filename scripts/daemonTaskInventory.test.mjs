import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/features/terminal/api/daemonTaskInventory.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("inventory.ts", source, ts.ScriptTarget.Latest, true);
const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join("\n");
const code = ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(read) {
  const exports = {}, subscriptions = [], timers = new Set();
  let calls = 0;
  runInNewContext(code, {
    exports, invoke: async () => { calls++; return read(); },
    useSyncExternalStore: (subscribe, get) => { subscriptions.push(subscribe(() => {})); return get(); },
    setInterval: callback => { timers.add(callback); return callback; },
    clearInterval: token => timers.delete(token),
  });
  return { ...exports, calls: () => calls, timers, subscriptions };
}

test("toolbars and pets share one in-flight inventory query and one polling timer", async () => {
  let resolve;
  const h = harness(() => new Promise(yes => { resolve = yes; }));
  h.useDaemonTaskInventory(); h.useDaemonTaskInventory(); h.useDaemonTaskInventory();
  h.useDaemonTaskInventory(false);
  assert.equal(h.calls(), 1);
  assert.equal(h.timers.size, 1);
  const pending = h.refreshDaemonTaskInventory();
  resolve([{ sessionId: "synthetic", alive: true }]);
  await pending;
  assert.equal(h.getDaemonTaskInventory().status, "fresh");
  h.subscriptions[0]();
  assert.equal(h.timers.size, 1);
  h.subscriptions[1]();
  assert.equal(h.timers.size, 1);
  h.subscriptions[2]();
  assert.equal(h.timers.size, 0);
  h.subscriptions[3]();
});

test("宠物E接入共享任务清单，停用时不投影后台缓存", () => {
  const coordinator = readFileSync(new URL("../src/features/terminal/hooks/useDesktopPetECoordinator.ts", import.meta.url), "utf8");
  assert.match(coordinator, /useDaemonTaskInventory\(tracking && isTauri\(\)\)/);
  assert.match(coordinator, /tracking && isTauri\(\) \? daemonTasks : \[\]/);
  assert.doesNotMatch(coordinator, /"pty_daemon_sessions"|setBackgroundTasks/);
});

test("busy inventory keeps last-good tasks and exposes stale instead of zero tasks", async () => {
  let fail = true;
  const h = harness(async () => {
    if (fail) throw new Error("session state busy");
    return [{ sessionId: "running", alive: true }];
  });
  await h.refreshDaemonTaskInventory();
  assert.equal(h.getDaemonTaskInventory().status, "unknown");
  fail = false;
  await h.refreshDaemonTaskInventory();
  fail = true;
  await h.refreshDaemonTaskInventory();
  assert.equal(h.getDaemonTaskInventory().status, "stale");
  assert.equal(h.getDaemonTaskInventory().tasks[0].sessionId, "running");
  fail = false;
  await h.refreshDaemonTaskInventory();
  assert.equal(h.getDaemonTaskInventory().status, "fresh");
});
