import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-desktop-pet-e-state-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const protocolSource = readFileSync(new URL("../pet-e/src/bridge/protocol.ts", import.meta.url), "utf8");
const protocolOutput = ts.transpileModule(protocolSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  fileName: "protocol.ts",
}).outputText;
writeFileSync(join(tempDir, "desktopPetE.mjs"), protocolOutput, "utf8");

writeFileSync(join(tempDir, "agentTerminal.mjs"), [
  "export function shouldIncludeAgentTerminal() { return true; }",
].join("\n"), "utf8");
writeFileSync(join(tempDir, "desktopPetStatus.mjs"), [
  "export function resolveDesktopPetOpenSessionStatus(input) {",
  "  return { status: input.frontendStatus, updatedAt: Date.parse(input.frontendDetails?.updatedAt ?? '') || 0 };",
  "}",
].join("\n"), "utf8");

const promptSource = readFileSync(new URL("../src/shared/lib/desktopPetETerminalPrompt.ts", import.meta.url), "utf8");
writeFileSync(join(tempDir, "desktopPetETerminalPrompt.mjs"), ts.transpileModule(promptSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  fileName: "desktopPetETerminalPrompt.ts",
}).outputText, "utf8");
const promptState = await import(pathToFileURL(join(tempDir, "desktopPetETerminalPrompt.mjs")).href);

const stateSource = readFileSync(new URL("../src/shared/lib/desktopPetEState.ts", import.meta.url), "utf8");
const stateOutput = ts.transpileModule(stateSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  fileName: "desktopPetEState.ts",
}).outputText
  .replace('from "../../features/agents/api/agentTerminal"', 'from "./agentTerminal.mjs"')
  .replace('from "../../features/desktop-pet/lib/desktopPetStatus"', 'from "./desktopPetStatus.mjs"')
  .replace('from "./desktopPetETerminalPrompt"', 'from "./desktopPetETerminalPrompt.mjs"')
  .replace('from "./desktopPetE"', 'from "./desktopPetE.mjs"');
writeFileSync(join(tempDir, "desktopPetEState.mjs"), stateOutput, "utf8");
const state = await import(pathToFileURL(join(tempDir, "desktopPetEState.mjs")).href);

function candidate(sessionId, status, updatedAt, overrides = {}) {
  return {
    sessionId,
    source: "claude",
    agentLabel: "Claude",
    title: sessionId,
    status,
    updatedAt,
    sessionAlive: true,
    ...overrides,
  };
}

function snapshot(candidates, overrides = {}) {
  return state.deriveDesktopPetESnapshot({
    instanceId: "instance-1",
    generation: 1,
    revision: 2,
    generatedAt: 10_000,
    candidates,
    ...overrides,
  }, "green");
}

test("all four colors are counted and waiting has the highest mood priority", () => {
  const pendingAction = {
    id: "question-1",
    kind: "question",
    requestGeneration: 1,
    adapterMode: "interactive",
    submitting: false,
  };
  const result = snapshot([
    candidate("green", "running", 100),
    candidate("yellow", "attention", 200, { pendingAction }),
    candidate("red", "failed", 300),
    candidate("blue", "done", 400),
  ]);
  assert.deepEqual(result.counts, { green: 1, yellow: 1, red: 1, blue: 1 });
  assert.equal(result.mood, "yellow");
  assert.deepEqual(result.cliLabel, { agentLabel: "Claude", color: "green", otherTaskCount: 3 });
});

test("ordinary attention does not enter the four-color task counts", () => {
  const result = snapshot([candidate("attention", "attention", 200)]);
  assert.deepEqual(result.counts, { green: 0, yellow: 0, red: 0, blue: 0 });
  assert.deepEqual(result.tasks, []);
});

test("ordinary attention preserves the prior terminal task state", () => {
  const previous = [candidate("session", "running", 100)];
  const current = [candidate("session", "attention", 200)];
  const merged = state.mergeDesktopPetECandidatesWithHistory(
    previous,
    current,
    new Set(["session"]),
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "running");
  assert.equal(merged[0].updatedAt, 100);
  assert.deepEqual(snapshot(merged).counts, { green: 1, yellow: 0, red: 0, blue: 0 });
});

test("jump-only user actions remain yellow through an explicit pending action", () => {
  const pendingAction = {
    id: "jump-only-1",
    kind: "approval",
    requestGeneration: 1,
    adapterMode: "jump-only",
    submitting: false,
  };
  const result = snapshot([candidate("attention", "attention", 200, { pendingAction })]);
  assert.deepEqual(result.counts, { green: 0, yellow: 1, red: 0, blue: 0 });
  assert.equal(result.tasks[0].pendingAction?.adapterMode, "jump-only");
});

test("a newer task in the same session replaces an older terminal state", () => {
  const result = snapshot([
    candidate("same", "failed", 100),
    candidate("same", "running", 200),
  ]);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].color, "green");
});

test("viewed red and blue tasks clear by exact task id", () => {
  const initial = snapshot([
    candidate("red", "failed", 100),
    candidate("blue", "done", 200),
  ]);
  const viewed = new Set(initial.tasks.map((task) => task.id));
  const cleared = snapshot([
    candidate("red", "failed", 100),
    candidate("blue", "done", 200),
  ], { viewedTerminalTaskIds: viewed });
  assert.deepEqual(cleared.tasks, []);
});

test("terminal history retains only red and blue records and marks ended sessions", () => {
  const previous = [
    candidate("failed", "failed", 100),
    candidate("done", "done", 100),
    candidate("running", "running", 100),
  ];
  const merged = state.mergeDesktopPetECandidatesWithHistory(previous, [], new Set(["done"]));
  assert.deepEqual(merged.map((item) => [item.sessionId, item.sessionAlive]), [
    ["failed", false],
    ["done", true],
  ]);
});

test("closed sessions stamp endedAt and drop out of the four colors after the TTL", () => {
  const ttl = state.DESKTOP_PET_E_ENDED_SESSION_TTL_MS;
  const previous = [candidate("gone", "done", 100)];
  const live = new Set();

  const stamped = state.mergeDesktopPetECandidatesWithHistory(previous, [], live, 1_000);
  assert.deepEqual(stamped.map((item) => [item.sessionId, item.sessionAlive, item.endedAt]), [
    ["gone", false, 1_000],
  ]);

  // TTL 未到：保持原有 endedAt，不因为重算而续期。
  const kept = state.mergeDesktopPetECandidatesWithHistory(stamped, [], live, 1_000 + ttl - 1);
  assert.deepEqual(kept.map((item) => item.endedAt), [1_000]);
  assert.deepEqual(snapshot(kept).counts, { green: 0, yellow: 0, red: 0, blue: 1 });

  const expired = state.mergeDesktopPetECandidatesWithHistory(stamped, [], live, 1_000 + ttl);
  assert.deepEqual(expired, []);
  assert.deepEqual(snapshot(expired).counts, { green: 0, yellow: 0, red: 0, blue: 0 });
});

test("a restored session clears endedAt so the TTL restarts on the next close", () => {
  const ttl = state.DESKTOP_PET_E_ENDED_SESSION_TTL_MS;
  const closed = state.mergeDesktopPetECandidatesWithHistory(
    [candidate("session", "done", 100)],
    [],
    new Set(),
    1_000,
  );
  const restored = state.mergeDesktopPetECandidatesWithHistory(
    closed,
    [],
    new Set(["session"]),
    1_000 + ttl - 1,
  );
  assert.deepEqual(restored.map((item) => [item.sessionAlive, item.endedAt]), [[true, null]]);

  // 重新计时：原本早已过期的时间点仍应保留。
  const reclosed = state.mergeDesktopPetECandidatesWithHistory(
    restored,
    [],
    new Set(),
    1_000 + ttl * 3,
  );
  assert.deepEqual(reclosed.map((item) => [item.sessionAlive, item.endedAt]), [
    [false, 1_000 + ttl * 3],
  ]);
});

test("fallback terminal errors keep one stable task identity until the status changes", () => {
  const input = (generatedAt) => ({
    instanceId: "instance-1",
    generation: 1,
    revision: 0,
    generatedAt,
    sessions: [{ id: "terminal-error", title: "Terminal", cliTool: "claude" }],
    persistedSessions: [],
    projects: [],
    activeSessionId: null,
    sessionStatuses: { "terminal-error": "error" },
    sessionStatusUpdatedAt: { "terminal-error": 5_000 },
    tabNotifications: {},
    tabStatusDetails: {},
    ptyOutputActivityAt: {},
    backgroundTasks: [],
  });
  const first = state.deriveDesktopPetECandidates(input(10_000));
  const second = state.deriveDesktopPetECandidates(input(20_000));
  assert.equal(first[0].updatedAt, 5_000);
  assert.equal(second[0].updatedAt, 5_000);
  assert.equal(
    snapshot(first).tasks[0].id,
    snapshot(second).tasks[0].id,
  );
});

test("snapshot acceptance rejects old instances and non-increasing revisions", () => {
  const current = { instanceId: "instance-1", generation: 2, revision: 5 };
  assert.equal(state.shouldAcceptDesktopPetESnapshot(current, { ...current, revision: 6 }), true);
  assert.equal(state.shouldAcceptDesktopPetESnapshot(current, { ...current, revision: 5 }), false);
  assert.equal(state.shouldAcceptDesktopPetESnapshot(current, { ...current, generation: 1, revision: 99 }), false);
  assert.equal(state.shouldAcceptDesktopPetESnapshot(current, { ...current, instanceId: "old" }), false);
});

const terminalPrompt = { id: "prompt-1", kind: "custom", title: "选择方案", startedAt: 1_000 };
const piSession = { id: "tab-1", title: "Pi", kind: "pty", cliTool: "pi", cliSessionId: "pi-1" };

// 只提供正式身份与独立状态，不设置通知、代答偏好或任何 broker 请求。
function piInput(overrides = {}) {
  return {
    instanceId: "frontend-1", generation: 1, revision: 0, generatedAt: 10_000,
    sessions: [piSession], persistedSessions: [], projects: [], activeSessionId: null,
    sessionStatuses: { "tab-1": "running" }, tabNotifications: {}, tabStatusDetails: {},
    ptyOutputActivityAt: {}, backgroundTasks: [],
    terminalPrompts: new Map([[promptState.desktopPetETerminalPromptScopeKey("tab-1", "pi-1"), terminalPrompt]]),
    ...overrides,
  };
}

test("只读等待可独立计入黄灯，任务身份与开始时间保持稳定", () => {
  const first = state.deriveDesktopPetECandidates(piInput());
  const second = state.deriveDesktopPetECandidates(piInput({ generatedAt: 20_000 }));
  const task = snapshot(first).tasks[0];
  assert.equal(task.color, "yellow");
  assert.equal(task.pendingAction, null);
  assert.equal(task.terminalPrompt, terminalPrompt);
  assert.equal(task.id, snapshot(second).tasks[0].id);
  assert.equal(task.updatedAt, 1_000);
  assert.deepEqual(snapshot(first).counts, { green: 0, yellow: 1, red: 0, blue: 0 });
  assert.equal(snapshot(first, { viewedTerminalTaskIds: new Set([task.id]) }).tasks.length, 1);
});

test("只读等待要求精确 Pi 身份与存活 PTY，不投影到 SSH 或其他面板", () => {
  for (const session of [
    { ...piSession, cliSessionId: "pi-other" }, { ...piSession, cliSessionId: undefined },
    { ...piSession, cliTool: "claude" }, { ...piSession, environmentType: "ssh" },
    { ...piSession, sshHostId: "host" }, { ...piSession, kind: "file-editor" },
    { ...piSession, kind: "subagent-transcript" }, { ...piSession, remoteHandoff: {} },
  ]) {
    const result = snapshot(state.deriveDesktopPetECandidates(piInput({ sessions: [session] })));
    assert.equal(result.counts.yellow, 0);
    assert.ok(result.tasks.every((task) => !task.terminalPrompt));
  }
  for (const status of ["exited", "error", undefined]) {
    const result = snapshot(state.deriveDesktopPetECandidates(piInput({ sessionStatuses: { "tab-1": status } })));
    assert.equal(result.counts.yellow, 0);
  }
  const sshProject = piInput({ sessions: [{ ...piSession, projectId: "project" }], projects: [{ id: "project", environment_type: "ssh" }] });
  assert.equal(snapshot(state.deriveDesktopPetECandidates(sshProject)).counts.yellow, 0);
  const deadDaemon = piInput({ backgroundTasks: [{ sessionId: "tab-1", alive: false, createdAtMs: 0 }] });
  assert.equal(snapshot(state.deriveDesktopPetECandidates(deadDaemon)).counts.yellow, 0);
});

test("后台和 WSL 会话使用原有返回会话定位，同一会话不重复计数", () => {
  const backgroundTask = { sessionId: "tab-1", alive: true, createdAtMs: 0, taskStatus: "running" };
  const input = piInput({
    sessions: [], persistedSessions: [{ ...piSession, environmentType: "wsl", wslDistroName: "Ubuntu" }],
    backgroundTasks: [backgroundTask],
  });
  const background = snapshot(state.deriveDesktopPetECandidates(input));
  assert.equal(background.counts.yellow, 1);
  assert.equal(background.tasks[0].daemonOnly, true);
  assert.equal(background.tasks[0].sessionAlive, true);
  assert.equal(snapshot(state.deriveDesktopPetECandidates({ ...input, backgroundTasks: [{ ...backgroundTask, alive: false }] })).counts.yellow, 0);
  const open = snapshot(state.deriveDesktopPetECandidates({ ...input, sessions: [piSession] }));
  assert.equal(open.tasks.length, 1);
  assert.equal(open.tasks[0].daemonOnly, false);
});

test("真实待答和提交中请求优先于只读等待及更新的普通状态", () => {
  const pendingAction = {
    id: "question-1", kind: "question", requestGeneration: 1,
    adapterMode: "interactive", submitting: true,
  };
  const candidates = state.deriveDesktopPetECandidates(piInput({ pendingActions: new Map([["tab-1", pendingAction]]) }));
  const combined = snapshot(candidates);
  assert.equal(combined.tasks.length, 1);
  assert.equal(combined.tasks[0].pendingAction, pendingAction);
  assert.equal(combined.tasks[0].terminalPrompt, terminalPrompt);
  const real = candidate("same", "attention", 100, { pendingAction });
  const readonly = candidate("same", "attention", 200, { terminalPrompt });
  const running = candidate("same", "running", 300);
  for (const ordered of [[real, readonly, running], [running, readonly, real], [readonly, real, running]]) {
    const result = snapshot(ordered);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].pendingAction, pendingAction);
    assert.equal(result.tasks[0].pendingAction.submitting, true);
  }
});

test("结束或消失的只读等待不进入红蓝历史，也不复用为普通通知黄灯", () => {
  for (const status of ["attention", "done", "failed"]) {
    const previous = [candidate("session", status, 100, { terminalPrompt })];
    assert.deepEqual(state.mergeDesktopPetECandidatesWithHistory(previous, [], new Set()), []);
    const merged = state.mergeDesktopPetECandidatesWithHistory(previous, [candidate("session", "attention", 200)], new Set(["session"]));
    assert.equal(snapshot(merged).tasks.length, 0);
  }
  const resumed = state.mergeDesktopPetECandidatesWithHistory(
    [candidate("session", "attention", 100, { terminalPrompt })],
    [candidate("session", "running", 200)], new Set(["session"]),
  );
  assert.equal(snapshot(resumed).tasks[0].color, "green");
  assert.equal(snapshot(resumed).tasks[0].terminalPrompt, undefined);
});
