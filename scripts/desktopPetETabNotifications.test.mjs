import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

function load(relativePath, dependencies = {}) {
  const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: relativePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports,
    require: (name) => {
      if (name in dependencies) return dependencies[name];
      throw new Error(`未提供的依赖：${name}`);
    },
  }, { filename: relativePath });
  return module.exports;
}

const projection = load("src/features/terminal/lib/desktopPetETabNotifications.ts");
const { useDesktopPetETabNotifications } = load("src/features/terminal/hooks/useDesktopPetETabNotifications.ts", {
  react: React,
  "../lib/desktopPetETabNotifications": projection,
});

// 使用真实 React Hook 入口；仅隔离平台与无关的整个终端 store。
function render(notifications, statuses, pendingActions = new Map()) {
  let result;
  function Surface() {
    result = useDesktopPetETabNotifications(notifications, statuses, pendingActions);
    return null;
  }
  renderToStaticMarkup(React.createElement(Surface));
  return result;
}

const plain = (value) => Object.fromEntries(Object.entries(value));

test("没有待答时保留原通知引用，缺省 Hook 仍为明确 none", () => {
  const notifications = { idle: "none", done: "finished" };
  const statuses = { idle: { shell: "running" }, done: { hook: "finished" } };
  const result = render(notifications, statuses);
  assert.equal(result.tabNotifications, notifications);
  assert.deepEqual(plain(result.hookNotifications), { idle: "none", done: "finished" });
});

test("真实待答覆盖两种标签投影但不修改原通知或 Hook 状态", () => {
  const notifications = { waiting: "finished", other: "running" };
  const statuses = { waiting: { hook: "failed" }, other: { hook: "running" } };
  const pendingActions = new Map([["waiting", { id: "question" }], ["background", { id: "permission" }]]);
  const result = render(notifications, statuses, pendingActions);
  assert.deepEqual(plain(result.tabNotifications), { waiting: "attention", other: "running", background: "attention" });
  assert.deepEqual(plain(result.hookNotifications), { waiting: "attention", other: "running", background: "attention" });
  assert.deepEqual(notifications, { waiting: "finished", other: "running" });
  assert.equal(statuses.waiting.hook, "failed");
  const released = render(notifications, statuses);
  assert.equal(released.tabNotifications, notifications);
  assert.equal(released.hookNotifications.waiting, "failed");
  assert.equal("background" in released.hookNotifications, false);
});

test("空清单不生成幽灵状态，控制器仍接独立投影和真实待答可见性", () => {
  const result = render({}, {});
  assert.deepEqual(plain(result.tabNotifications), {});
  assert.deepEqual(plain(result.hookNotifications), {});
  const controller = readFileSync(new URL("../src/features/terminal/hooks/useTerminalTabsController.tsx", import.meta.url), "utf8");
  assert.match(controller, /useDesktopPetETabNotifications\([\s\S]*terminalTabNotifications, tabStatuses, pendingActions/);
  assert.match(controller, /for \(const sessionId of pendingActions\.keys\(\)\)[\s\S]*next\.add\(sessionId\)/);
});
