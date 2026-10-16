import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const storeSource = read("features/terminal/store/terminalStore.ts");
const storeAst = ts.createSourceFile("store.ts", storeSource, ts.ScriptTarget.Latest, true);

// 从真实 store 提取 action，仅替换外部副作用；测试不复制守卫实现。
function action(name, bindings) {
  let expression;
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(storeAst) === name) expression = node.initializer.getText(storeAst);
    ts.forEachChild(node, visit);
  };
  visit(storeAst);
  assert.ok(expression, name);
  const code = ts.transpileModule(`const action = ${expression}; action;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return vm.runInNewContext(code, bindings);
}

const blockedActions = {
  reorderWorkspans: ["a", "b"],
  restoreWorkspanToSinglePane: ["a"],
  mergeWorkspanAtPaneEdge: ["a", "b", "p", "right"],
  reorderSessions: ["a", "b"],
  moveSessionToPane: ["a", "p"],
  detachSessionToWorkspan: ["a"],
  splitSessionToPaneEdge: ["a", "p", "right"],
  splitPaneEmpty: ["p", "horizontal"],
  splitTerminal: ["a", "horizontal"],
  unsplitTerminal: ["a"],
  setSplitRatio: ["p", 0.8],
};

for (const [name, args] of Object.entries(blockedActions)) {
  test(`locked ${name} stops before state, persistence or PTY side effects`, async () => {
    let attempts = 0;
    const run = action(name, {
      guardTerminalLayoutChange: () => { attempts++; return true; },
      get: () => assert.fail("locked action must not read/mutate session state"),
    });
    const result = await run(...args);
    assert.equal(result, name === "splitTerminal" ? null : undefined);
    assert.equal(attempts, 1);
  });
}

test("unlock restores real tab reordering and persistence", () => {
  const writes = [];
  const workspans = [{ id: "a" }, { id: "b" }];
  const run = action("reorderWorkspans", {
    guardTerminalLayoutChange: () => false,
    get: () => ({ workspans, activeWorkspanId: "a", sessions: [] }),
    reorderTerminalWorkspans: (items) => [...items].reverse(),
    set: (value) => writes.push(value.workspans.map((item) => item.id)),
    persistWorkspanState: (items) => writes.push(items.map((item) => item.id)),
  });
  run("a", "b");
  assert.deepEqual(writes, [["b", "a"], ["b", "a"]]);
});

test("locking during async split closes only the new PTY and releases both snapshots", async () => {
  let locked = false;
  const effects = [];
  const run = action("splitTerminal", {
    guardTerminalLayoutChange: () => locked,
    get: () => ({ workspans: [], sessions: [{ id: "existing" }] }),
    findWorkspanBySession: () => ({ id: "w", paneTree: {} }),
    findPaneLeafBySession: () => ({ id: "p" }),
    getOsPlatform: async () => "windows",
    resolvePtyLaunch: async () => ({ shell: "pwsh", invokeArgs: {}, providerSnapshot: "provider", extensionSnapshotId: "extension" }),
    recordCrashActivity: () => {},
    summarizeStartupCmd: () => "",
    createSplitSessionTitle: () => "Terminal",
    getProjectAgentTerminalMetadata: () => ({}),
    getDeepSeekTuiLaunchSessionId: () => undefined,
    terminalProcessManager: {
      create: async () => { locked = true; return "new-pty"; },
      subscribeStatus: async () => () => effects.push("unsubscribe"),
      close: async (id) => effects.push(`close:${id}`),
    },
    releaseProviderSnapshot: (id) => effects.push(`provider:${id}`),
    releaseProjectExtensionSnapshot: (id) => effects.push(`extension:${id}`),
    set: () => assert.fail("must not commit layout"),
  });
  assert.equal(await run("existing", "horizontal"), null);
  assert.deepEqual(effects, ["unsubscribe", "close:new-pty", "provider:provider", "extension:extension"]);
});

const dragCode = ts.transpileModule(read("features/terminal/lib/lockedLayoutDrag.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dragExports = {};
vm.runInNewContext(dragCode, { exports: dragExports });

function gesture() {
  const listeners = new Map();
  let attempts = 0;
  const target = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  };
  const cleanup = dragExports.observeLockedLayoutDrag(target, { clientX: 10, clientY: 10, pointerId: 1 }, 3, () => attempts++);
  return {
    move: (patch = {}) => listeners.get("pointermove")?.({ clientX: 11, clientY: 10, pointerId: 1, buttons: 1, ...patch }),
    emit: (type) => listeners.get(type)?.({ pointerId: 1 }),
    cleanup,
    get attempts() { return attempts; },
    get listening() { return listeners.size; },
  };
}

test("ordinary clicks and sub-threshold movement do not notify", () => {
  const drag = gesture();
  drag.move();
  drag.move({ clientX: 13 });
  drag.emit("pointerup");
  assert.equal(drag.attempts, 0);
  assert.equal(drag.listening, 0);
});

test("real drag notifies once and ignores other pointers", () => {
  const drag = gesture();
  drag.move({ pointerId: 2, clientX: 30 });
  assert.equal(drag.attempts, 0);
  drag.move({ clientX: 14 });
  drag.move({ clientX: 30 });
  assert.equal(drag.attempts, 1);
  assert.equal(drag.listening, 0);
});

for (const event of ["pointercancel", "blur", "unmount", "released"]) {
  test(`${event} cleans pointer observation without notifying`, () => {
    const drag = gesture();
    if (event === "unmount") drag.cleanup();
    else if (event === "released") drag.move({ buttons: 0, clientX: 50 });
    else drag.emit(event);
    drag.move({ clientX: 50 });
    assert.equal(drag.attempts, 0);
    assert.equal(drag.listening, 0);
  });
}

test("lock notification supplies an unlock action with a stable toast id", () => {
  const source = read("features/terminal/api/terminalLayoutLock.ts").replace(/^import .*;\r?\n/gm, "");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  let locked = true;
  const notifications = [];
  const dismissals = [];
  vm.runInNewContext(code, {
    exports,
    toast: { info: (text, options) => notifications.push({ text, ...options }), dismiss: (id) => dismissals.push(id) },
    translateCurrent: (key) => key,
    useSettingsStore: { getState: () => ({ terminalLayoutLocked: locked, update: (_key, value) => { locked = value; } }) },
  });
  assert.equal(exports.guardTerminalLayoutChange(), true);
  assert.equal(exports.guardTerminalLayoutChange(), true);
  assert.equal(notifications[0].id, notifications[1].id);
  assert.equal(notifications[0].style, undefined);
  assert.equal(notifications[0].actionButtonStyle, undefined);
  notifications[0].action.onClick();
  assert.equal(locked, false);
  assert.equal(exports.guardTerminalLayoutChange(), false);
  assert.deepEqual(dismissals, [notifications[0].id]);
});

test("lock indicator is absent by default and both UI entry points unlock", () => {
  let locked = false;
  const exports = {};
  const modules = {
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": { LockKeyhole: "lock-icon", UnlockKeyhole: "unlock-icon" },
    "../../../shared/preferences/settingsStore": { useSettingsStore: (select) => select({ terminalLayoutLocked: locked }) },
    "../../../shared/i18n": { useI18n: () => ({ t: (key) => key }) },
    "../../../shared/ui/context-menu": { ContextMenuItem: "menu-item" },
    "./terminalLayoutLock": { setTerminalLayoutLocked: (value) => { locked = value; } },
  };
  const code = ts.transpileModule(read("features/terminal/api/TerminalLayoutLockControls.tsx"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, { exports, require: (name) => {
    assert.ok(modules[name], name);
    return modules[name];
  } });
  assert.equal(exports.TerminalLayoutLockIndicator(), null);
  exports.TerminalLayoutLockMenuItem().props.onSelect();
  assert.equal(locked, true);
  const button = exports.TerminalLayoutLockIndicator();
  assert.equal(button.type, "button");
  assert.equal(button.props["aria-label"], "terminal.layoutLock.unlockHint");
  button.props.onClick();
  assert.equal(locked, false);
  locked = true;
  exports.TerminalLayoutLockMenuItem().props.onSelect();
  assert.equal(locked, false);
});

// 执行真实分隔线处理器，验证 DOM 预览与 store 提交之间的锁定竞态。
function dividerGesture(initiallyLocked = false) {
  const source = read("features/terminal/components/SplitTerminalView.tsx");
  const ast = ts.createSourceFile("split.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "handleDragStart") {
      expression = node.initializer.arguments[0].getText(ast);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const listeners = new Map();
  const frames = new Map();
  const previews = [];
  const commits = [];
  const activeDragCleanupRef = { current: null };
  const style = { cursor: "auto", userSelect: "auto" };
  let locked = initiallyLocked;
  let notifications = 0;
  let frameId = 0;
  const events = {
    addEventListener: (type, cb) => listeners.set(type, cb),
    removeEventListener: (type) => listeners.delete(type),
  };
  const run = vm.runInNewContext(ts.transpileModule(`const handler = ${expression}; handler;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    guardTerminalLayoutChange: () => { if (locked) notifications++; return locked; },
    isTerminalLayoutLocked: () => locked,
    containerRef: { current: { getBoundingClientRect: () => ({ left: 0, top: 0 }) } },
    document: { body: { style }, ...events },
    window: events,
    applyDragPreview: (value) => previews.push(value.ratio),
    setSplitRatio: (_id, ratio) => commits.push(ratio),
    clampSplitRatio: (value) => value,
    liveDragLayoutRef: { current: null },
    activeDragCleanupRef,
    setDraggingSplitId: () => {},
    requestAnimationFrame: (cb) => { frames.set(++frameId, cb); return frameId; },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  run({ id: "split", ratio: 0.5, direction: "horizontal" }, { left: 0, top: 0, width: 100, height: 100 }, { button: 0, preventDefault() {} });
  return {
    previews, commits, style,
    move() {
      listeners.get("mousemove")?.({ clientX: 80, clientY: 0 });
      for (const [id, cb] of frames) { frames.delete(id); cb(); }
    },
    finish: () => listeners.get("mouseup")?.({ clientX: 80, clientY: 0 }),
    lock() { locked = true; activeDragCleanupRef.current?.(); },
    get listening() { return listeners.size; },
    get notifications() { return notifications; },
  };
}

test("locked divider never previews or commits a resize", () => {
  const drag = dividerGesture(true);
  assert.equal(drag.notifications, 1);
  assert.deepEqual(drag.previews, []);
  assert.deepEqual(drag.commits, []);
  assert.equal(drag.listening, 0);
});

test("locking during divider movement rolls preview back and removes listeners", () => {
  const drag = dividerGesture();
  drag.move();
  assert.equal(drag.previews.at(-1), 0.8);
  drag.lock();
  drag.finish();
  assert.equal(drag.previews.at(-1), 0.5);
  assert.deepEqual(drag.commits, []);
  assert.equal(drag.listening, 0);
  assert.deepEqual(drag.style, { cursor: "auto", userSelect: "auto" });
});

test("unlocked divider commits its final ratio", () => {
  const drag = dividerGesture();
  drag.move();
  drag.finish();
  assert.deepEqual(drag.commits, [0.8]);
  assert.equal(drag.listening, 0);
});
