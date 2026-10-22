import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-desktop-pet-status-"));
// 退出时清理本测试生成的临时模块目录。
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/features/desktop-pet/lib/desktopPetStatus.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "desktopPetStatus.ts",
}).outputText;
const outputPath = join(tempDir, "desktopPetStatus.mjs");
writeFileSync(outputPath, output, "utf8");
const status = await import(pathToFileURL(outputPath).href);

// 以固定时间和默认空状态调用桌宠会话状态解析器。
function resolve(overrides = {}) {
  return status.resolveDesktopPetOpenSessionStatus({
    frontendStatus: "none",
    outputActivityAt: 0,
    now: 10_000,
    ...overrides,
  });
}

// 验证后续 PTY 输出不能重新打开已完成或失败的任务。
test("explicit completed and failed states cannot be reopened by later PTY output", () => {
  assert.deepEqual(resolve({
    frontendStatus: "done",
    frontendDetails: { status: "done", updatedAt: new Date(8_000).toISOString() },
    outputActivityAt: 9_500,
  }), { status: "done", updatedAt: 8_000 });
  assert.deepEqual(resolve({
    frontendStatus: "failed",
    frontendDetails: { status: "failed", updatedAt: new Date(8_500).toISOString() },
    outputActivityAt: 9_800,
  }), { status: "failed", updatedAt: 8_500 });
});

// 验证注意状态和 daemon 生命周期状态优先于输出活跃提示。
test("attention and daemon lifecycle states remain authoritative", () => {
  assert.deepEqual(resolve({
    frontendStatus: "attention",
    frontendDetails: { status: "attention", updatedAt: new Date(9_000).toISOString() },
    outputActivityAt: 9_900,
  }), { status: "attention", updatedAt: 9_000 });
  assert.deepEqual(resolve({
    daemonTask: {
      sessionId: "session-1",
      alive: true,
      taskStatus: "done",
      taskUpdatedAtMs: 9_200,
      createdAtMs: 1_000,
    },
    outputActivityAt: 9_900,
  }), { status: "done", updatedAt: 9_200 });
});

test("明确空闲按时间覆盖旧错误，重绘不能冒充新任务", () => {
  const task = { sessionId: "pi-tab", alive: true, taskStatus: "none", taskUpdatedAtMs: 9_200, createdAtMs: 1_000 };
  assert.deepEqual(resolve({
    frontendStatus: "failed", frontendDetails: { status: "failed", updatedAt: new Date(8_000).toISOString() },
    daemonTask: task, outputActivityAt: 9_900,
  }), { status: "none", updatedAt: 9_200 });
  assert.deepEqual(resolve({
    frontendDetails: { status: "none", updatedAt: new Date(9_200).toISOString() }, outputActivityAt: 9_900,
  }), { status: "none", updatedAt: 9_200 });
  assert.deepEqual(resolve({
    frontendStatus: "running", frontendDetails: { status: "running", updatedAt: new Date(9_500).toISOString() },
    daemonTask: task,
  }), { status: "running", updatedAt: 9_500 });
});

// 去掉导入/再导出以隔离 UI 与存储依赖，执行真实后台状态投影而非复制判断。
function loadModuleBody(path, dependencies) {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const body = ast.statements.filter((node) => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
    .map((node) => node.getText(ast)).join("\n");
  const exports = {};
  vm.runInNewContext(ts.transpileModule(body, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, ...dependencies });
  return exports;
}

test("原桌面宠物的后台明确 none 不回退为进程存活即运行", () => {
  const pet = loadModuleBody("../src/features/desktop-pet/api/desktopPet.ts", {
    shouldIncludeAgentTerminal: () => true,
  });
  const task = { sessionId: "pi-tab", alive: true, taskStatus: "none", taskUpdatedAtMs: 9_200, createdAtMs: 1_000 };
  const input = {
    sessions: [], persistedSessions: [], activeSessionId: null, tabNotifications: {}, sessionStatuses: {},
    tabStatusDetails: {}, ptyOutputActivityAt: {}, projects: [], worktrees: [], sshHosts: [],
    backgroundTasks: [task], agentSessionsOnly: false, activeHandoff: null, handoffBusy: false, now: 10_000,
  };
  const idle = pet.deriveDesktopPetSnapshot(input);
  assert.equal(idle.targets[0].status, "none");
  assert.equal(idle.updatedAt, 9_200);
  assert.equal(idle.mood, "idle");
  assert.equal(idle.runningCount, 0);
  const unknown = pet.deriveDesktopPetSnapshot({ ...input, backgroundTasks: [{ ...task, taskStatus: undefined }] });
  assert.equal(unknown.mood, "working", "未知状态仍沿用原有回退");
  const failed = pet.deriveDesktopPetSnapshot({ ...input, backgroundTasks: [{ ...task, taskStatus: "failed" }] });
  assert.equal(failed.mood, "error");
});

test("后台面板区分明确空闲与未知状态，并提供中英文空闲文案", () => {
  const path = "../src/features/terminal/components/BackgroundTasksPanel.tsx";
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const resolver = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "resolveTaskStatus");
  assert.ok(resolver);
  const context = { exports: {} };
  vm.runInNewContext(ts.transpileModule(`${resolver.getText(ast)}\nexports.resolve = resolveTaskStatus;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  assert.equal(context.exports.resolve({ alive: true, taskStatus: "none" }), "none");
  assert.equal(context.exports.resolve({ alive: true }), "running");
  assert.equal(context.exports.resolve({ alive: false }), "done");
  assert.match(source, /task\.status === "none" \? t\("terminal\.backgroundTasks\.idle"\)/);
  for (const locale of ["zh-CN", "en-US"]) {
    const messages = readFileSync(new URL(`../src/shared/i18n/messages/terminal.${locale}.ts`, import.meta.url), "utf8");
    assert.match(messages, /"terminal\.backgroundTasks\.idle":\s*"[^"\n]+"/);
  }
});

// 验证没有生命周期状态时，仅近期 PTY 输出提供临时运行提示。
test("recent PTY output only supplies a short-lived hint when no lifecycle state exists", () => {
  assert.deepEqual(resolve({ outputActivityAt: 9_500 }), {
    status: "running",
    updatedAt: 9_500,
  });
  assert.deepEqual(resolve({ outputActivityAt: 3_999 }), {
    status: "none",
    updatedAt: 0,
  });
});
