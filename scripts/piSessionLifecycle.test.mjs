import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("../src/shared/lib/piSessionLifecycle.ts");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const context = vm.createContext({ exports: {} });
vm.runInContext(code, context);
const lifecycle = context.exports;
const start = { tabId: "tab", source: "pi", event: "SessionStart", sessionId: "new-session" };
const at = (value) => new Date(value).toISOString();

// 直接检查真实状态映射，而不是在夹具中重写一份相同实现。
const statusSource = read("../src/features/terminal/lib/terminalStatus.ts");
const ast = ts.createSourceFile("terminalStatus.ts", statusSource, ts.ScriptTarget.Latest, true);
const functions = ast.statements.filter((node) => !ts.isImportDeclaration(node))
  .map((node) => node.getText(ast)).join("\n");
const statusContext = vm.createContext({ exports: {}, isPiSessionStart: lifecycle.isPiSessionStart });
vm.runInContext(ts.transpileModule(functions, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, statusContext);

function loadIsolated(path, dependencies = {}) {
  const text = read(path);
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const body = sourceFile.statements.filter((node) => !ts.isImportDeclaration(node))
    .map((node) => node.getText(sourceFile)).join("\n");
  const exports = {};
  vm.runInNewContext(ts.transpileModule(body, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, ...dependencies });
  return exports;
}

// 仅桩路由、存储和计时器边界；执行真正的终端状态更新流程。
function terminalFixture() {
  let state = {
    sessions: [{ id: "tab", kind: "pty", cliTool: "pi", cliSessionId: "old-session" }],
    splits: {}, tabStatuses: { tab: { hook: "failed", hookUpdatedAt: at(1_000), shell: "failed", shellUpdatedAt: at(900) } },
    tabNotifications: { tab: "failed" }, tabStatusDetails: { tab: { status: "failed", updatedAt: at(1_000) } },
    ptyOutputActivityAt: { tab: 1_001 }, statsPanelRefreshSeq: 0,
  };
  const api = {
    getState: () => state,
    setState: (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
  };
  const timers = new Map();
  let timerId = 0;
  const identity = loadIsolated("../src/features/terminal/store/terminalCliSession.ts");
  const { createTerminalRuntime } = loadIsolated("../src/features/terminal/store/terminalRuntime.ts", {
    ...statusContext.exports, ...lifecycle, ...identity,
    resolveCliHookTarget: ({ rawTabId }) => ({ tabId: rawTabId, reason: "exact" }),
    inferHookBindingSource: () => "pi", resolveHookWslDistroName: () => undefined,
    findProjectByPath: () => null, findWorktreeByPath: () => null,
    useProjectStore: { getState: () => ({ projects: [], worktrees: [] }) },
    useSessionStore: { getState: () => ({ sessions: [], saveSessions: async () => {} }) },
    HOOK_RUNNING_TIMEOUT_MS: 100,
    setTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
    logInfo() {}, logWarn() {}, logError() {},
  });
  api.setState(createTerminalRuntime(api.setState, api.getState, api).actions);
  return { api, timers };
}

test("真实终端更新清除旧 Hook/shell 错误，重新运行后才设运行状态", () => {
  const { api, timers } = terminalFixture();
  api.getState().handleCliHookEvent({ ...start, timestamp: at(2_000) });
  assert.equal(api.getState().sessions[0].cliSessionId, "new-session");
  assert.equal(api.getState().tabStatuses.tab.hook, "none");
  assert.equal(api.getState().tabStatuses.tab.shell, undefined);
  assert.equal(api.getState().ptyOutputActivityAt.tab, undefined);
  assert.equal(api.getState().tabNotifications.tab, "none");
  assert.equal(timers.size, 0);
  api.getState().handleCliHookEvent({ ...start, event: "UserPromptSubmit", timestamp: at(3_000) });
  assert.equal(api.getState().tabNotifications.tab, "running");
  assert.equal(timers.size, 1);
  api.getState().handleCliHookEvent({ ...start, event: "StopFailure", timestamp: at(4_000) });
  api.getState().handleCliHookEvent({ ...start, timestamp: at(2_000) });
  assert.equal(api.getState().tabNotifications.tab, "failed", "迟到的 SessionStart 不清除新错误");
});

test("迟到的 Pi 会话开始在绑定身份、持久化和更新状态前被丢弃", () => {
  const { api, timers } = terminalFixture();
  api.getState().handleCliHookEvent({ ...start, timestamp: at(2_000) });
  api.getState().handleCliHookEvent({ ...start, event: "UserPromptSubmit", timestamp: at(3_000) });
  const before = api.getState();
  api.getState().handleCliHookEvent({ ...start, sessionId: "old-session", timestamp: at(1_500) });
  assert.equal(api.getState(), before, "旧事件不能先回绑会话再被状态时间检查丢弃");
  assert.equal(api.getState().sessions[0].cliSessionId, "new-session");
  assert.equal(api.getState().tabNotifications.tab, "running");
  assert.equal(timers.size, 1);
  api.getState().handleCliHookEvent({ ...start, sessionId: "next-session", timestamp: at(4_000) });
  assert.equal(api.getState().sessions[0].cliSessionId, "next-session");
  assert.equal(api.getState().tabNotifications.tab, "none");
  assert.equal(timers.size, 0, "会话复位撤销上一轮工作超时");
});

test("其他 CLI 的会话开始不清旧终态", () => {
  const { api } = terminalFixture();
  api.getState().handleCliHookEvent({ ...start, source: "claude", timestamp: at(2_000) });
  assert.equal(api.getState().tabNotifications.tab, "failed");
});

test("只有带真实身份的本机/WSL Pi SessionStart 复位为空闲", () => {
  for (const environmentType of [undefined, "local", "wsl"]) {
    assert.equal(lifecycle.isPiSessionStart({ ...start, environmentType }), true);
    assert.equal(statusContext.exports.resolveCliHookStatus({ ...start, environmentType }).status, "none");
  }
  for (const changed of [
    { source: "claude" }, { source: "codex" }, { source: undefined }, { environmentType: "ssh" },
    { event: "Notification" }, { event: "UserPromptSubmit" }, { event: "DesktopPetEUiPrompt" },
    { tabId: " " }, { sessionId: "" }, { sessionId: undefined },
  ]) {
    assert.equal(lifecycle.isPiSessionStart({ ...start, ...changed }), false);
  }
  assert.equal(statusContext.exports.mapCliHookEvent("SessionStart"), null);
  assert.equal(statusContext.exports.resolveCliHookStatus({ ...start, source: "claude" }).status, null);
  assert.equal(statusContext.exports.resolveCliHookStatus({ ...start, event: "UserPromptSubmit" }).status, "running");
  assert.equal(statusContext.exports.resolveCliHookStatus({ ...start, event: "StopFailure" }).status, "failed");
});

test("迟到复位只按合法 Pi 身份和有效时间判定，不扩大其他 CLI 语义", () => {
  assert.equal(lifecycle.isStalePiSessionStart({ ...start, timestamp: at(1_000) }, at(2_000)), true);
  for (const changed of [
    { source: "claude" }, { environmentType: "ssh" }, { event: "StopFailure" },
    { sessionId: "" }, { timestamp: undefined }, { timestamp: "invalid" }, { timestamp: at(2_000) },
  ]) {
    assert.equal(lifecycle.isStalePiSessionStart({ ...start, timestamp: at(1_000), ...changed }, at(2_000)), false);
  }
  assert.equal(lifecycle.isStalePiSessionStart({ ...start, timestamp: at(1_000) }, undefined), false);
});

test("Pi 空闲覆盖较旧后台错误，较新运行/失败仍然优先", () => {
  const input = {
    frontendStatus: "none", frontendDetails: { updatedAt: at(2_000) },
    daemonTask: { taskStatus: "failed", taskUpdatedAtMs: 1_000, createdAtMs: 100 },
  };
  assert.equal(lifecycle.resolvePiSessionIdle("pi", input)?.updatedAt, 2_000);
  assert.equal(lifecycle.resolvePiSessionIdle("claude", input), null);
  for (const taskStatus of ["running", "failed", "attention", "done"]) {
    assert.equal(lifecycle.resolvePiSessionIdle("pi", {
      ...input, daemonTask: { ...input.daemonTask, taskStatus, taskUpdatedAtMs: 3_000 },
    }), null);
  }
  assert.equal(lifecycle.resolvePiSessionIdle("pi", {
    frontendStatus: "failed", frontendDetails: { updatedAt: at(1_000) },
    daemonTask: { taskStatus: "none", taskUpdatedAtMs: 2_000, createdAtMs: 100 },
  })?.updatedAt, 2_000);
  assert.equal(lifecycle.resolvePiSessionIdle("pi", {
    frontendStatus: "running", frontendDetails: { updatedAt: at(3_000) },
    daemonTask: { taskStatus: "none", taskUpdatedAtMs: 2_000, createdAtMs: 100 },
  }), null);
  assert.equal(lifecycle.resolvePiSessionIdle("pi", { frontendStatus: "none" }), null);
});

test("恢复后台会话时保留明确 none，不把它回退为存活即运行", () => {
  assert.equal(statusContext.exports.normalizeDaemonTaskStatus("none"), "none");
  assert.equal(statusContext.exports.resolveDaemonAttachTaskStatus({ taskStatus: "none", alive: true }), "none");
  assert.equal(statusContext.exports.resolveDaemonAttachTaskStatus({ taskStatus: undefined, alive: true }), "running");
});

test("上游薄接点沿用原事件，复位时清掉旧输出与 shell 状态", () => {
  const runtime = read("../src/features/terminal/store/terminalRuntime.ts");
  assert.match(runtime, /terminalOutputStopped = .*isPiSessionStart\(payload\)/);
  assert.match(runtime, /delete ptyOutputActivityAt\[tabId\]/);
  assert.match(runtime, /delete resolved\.shell/);
  assert.match(runtime, /incoming < existing/);
  assert.ok(runtime.indexOf("isStalePiSessionStart(payload") < runtime.indexOf("const cliSessionId = payload.sessionId"));
  const daemon = read("../src-tauri/src/infrastructure/daemon/server/hook_status.rs");
  assert.match(daemon, /pi_session_lifecycle::reset_status\(payload\)/);
  const ordinary = daemon.slice(daemon.indexOf("fn map_hook_event_to_task_status(event"),
    daemon.indexOf("fn map_hook_event_to_task_status_for_payload"));
  assert.doesNotMatch(ordinary, /"SessionStart"/);
  assert.doesNotMatch(source, /UserPromptSubmit|postHook|pendingAction|broker/);
});
