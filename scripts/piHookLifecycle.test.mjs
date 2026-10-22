import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
// fork 模板还从 Pi 虚拟模块与 node:crypto 引入；测试只桩边界，不要求安装 Pi。
const schema = () => ({});
function requireStub(name) {
  if (name === "typebox") {
    return { Type: { Object: schema, Array: schema, String: schema, Boolean: schema, Optional: schema } };
  }
  if (name === "@earendil-works/pi-tui") return {};
  return require(name);
}
// 与 Rust include_str! 的实际目标一致，启用全部生命周期模块。
function piTemplate() {
  const rustUrl = new URL("../src-tauri/src/features/hooks/settings/pi.rs", import.meta.url);
  const rust = readFileSync(rustUrl, "utf8");
  const templatePath = rust.match(/include_str!\("([^"]*pi_extension_template\.ts)"\)/);
  assert.ok(templatePath, "Pi 外部受管模板必须可定位");
  return readFileSync(new URL(templatePath[1], rustUrl), "utf8");
}

// 可在同一测试上运行修改前的外部模板；从测试所属 worktree 读取，避免误用另一个 HEAD。
function sourceFor(modules) {
  const source = process.env.PI_HOOK_BASELINE === "1"
    ? execFileSync("git", ["show", "HEAD:src-tauri/src/pi_extension_template.ts"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8",
    })
    : piTemplate();
  return source
    .replaceAll("__PI_SESSION_START__", String(modules.sessionStart))
    .replaceAll("__PI_RUNNING__", String(modules.running))
    .replaceAll("__PI_STOP__", String(modules.stop));
}

// 模板在隔离 realm 中执行；网络、计时器与 Pi UI 边界由夹具控制，不要求安装 Pi。
function host({ env = {}, pid = 100, modules = { sessionStart: true, running: true, stop: true }, fetchImpl } = {}) {
  const sent = [];
  const intervals = new Map();
  let intervalId = 0;
  const environment = {
    CLI_MANAGER_TAB_ID: "parent-tab", CLI_MANAGER_NOTIFY_PORT: "1234",
    CLI_MANAGER_NOTIFY_TOKEN: "test-token", ...env,
  };
  const context = vm.createContext({
    exports: {}, require: requireStub, crypto: { randomUUID },
    process: { pid, env: environment, cwd: () => "/workspace" },
    AbortController, setTimeout, clearTimeout,
    // 只记录计时器，不实际等待 5/20 秒；允许检查清理及迟到回调的作用域守卫。
    setInterval: (callback, delay) => {
      const id = ++intervalId;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    fetch: async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return fetchImpl ? fetchImpl(init, _url) : { ok: true };
    },
  });
  const code = ts.transpileModule(sourceFor(modules), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // 每次重载重新求值模块，但沿用同一 JS realm 的进程级桥接状态。
  function reloadModule() {
    context.exports = {};
    vm.runInContext(`(function(exports, require) {\n${code}\n})(exports, require);`, context);
  }
  reloadModule();
  function extension(sessionId = "root", ui = {}) {
    const handlers = new Map();
    let currentSession = sessionId;
    let idle = true;
    let pending = false;
    const ctx = {
      sessionManager: { getSessionId: () => currentSession },
      isIdle: () => idle, hasPendingMessages: () => pending,
      mode: "tui", ui,
    };
    context.exports.default({
      on: (event, callback) => { handlers.set(event, callback); },
      getAllTools: () => [],
    });
    return {
      emit: (event, data = {}) => handlers.get(event)?.(data, ctx),
      session: (id) => { currentSession = id; },
      busy: (value) => { idle = !value; },
      pending: (value) => { pending = value; },
    };
  }
  return { sent, env: environment, extension, reloadModule, intervals };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 15));
const ends = (h) => h.sent.filter((event) => ["Stop", "StopFailure", "Interrupt"].includes(event.event));
const start = (e) => { e.emit("before_agent_start"); e.emit("agent_start"); };
const result = (e, stopReason) => e.emit("message_end", { message: { role: "assistant", stopReason } });

test("nested Pi and same-process SDK sessions cannot finish/rebind the parent Tab", async () => {
  const root = host();
  const parent = root.extension();
  const earlySdkChild = root.extension("early-child");
  earlySdkChild.emit("session_start"); start(earlySdkChild); earlySdkChild.emit("agent_settled");
  await flush(); assert.equal(root.sent.length, 0);
  parent.emit("session_start"); start(parent);
  const nested = host({ pid: 200, env: { ...root.env } });
  const child = nested.extension("child"); child.emit("session_start"); start(child); child.emit("agent_settled");
  const sdkChild = root.extension("sdk-child"); sdkChild.emit("session_start"); start(sdkChild); sdkChild.emit("agent_settled");
  await flush();
  assert.equal(nested.sent.length, 0);
  assert.equal(ends(root).length, 0);
  assert(root.sent.every((event) => event.sessionId === "root"));
  parent.emit("agent_settled"); await flush();
  assert.equal(ends(root).length, 1);
});

test("one settlement per run, internal restarts do not duplicate running, next run still reports", async () => {
  const h = host(); const e = h.extension(); e.emit("session_start"); start(e);
  e.emit("agent_start"); e.emit("agent_start");
  e.emit("agent_settled"); e.emit("agent_settled"); await flush();
  e.emit("agent_settled"); await flush();
  assert.equal(ends(h).length, 1);
  assert.equal(h.sent.filter((x) => x.event === "UserPromptSubmit").length, 1);
  start(e); e.emit("agent_settled"); await flush();
  assert.equal(ends(h).length, 2);
  assert.notEqual(ends(h)[0].pi.runId, ends(h)[1].pi.runId);
  assert.equal(new Set(h.sent.map((x) => x.remoteEventId)).size, h.sent.length);
});

test("abort and final failure are not reported as success; retry success replaces intermediate error", async () => {
  const h = host(); const e = h.extension(); e.emit("session_start"); start(e);
  e.emit("agent_settled", { aborted: true }); await flush();
  start(e); result(e, "error"); e.emit("agent_settled", { aborted: false }); await flush();
  start(e); result(e, "error"); e.emit("agent_start"); result(e, "stop");
  e.emit("agent_settled", { aborted: false }); await flush();
  assert.deepEqual(ends(h).map((x) => x.event), ["Interrupt", "StopFailure", "Stop"]);
});

test("new run before dispatch, busy context and queued work invalidate a completion candidate", async () => {
  const h = host(); const e = h.extension(); e.emit("session_start"); start(e);
  e.emit("agent_settled"); start(e); await flush();
  assert.equal(ends(h).length, 0);
  e.busy(true); e.emit("agent_settled"); await flush();
  assert.equal(ends(h).length, 0);
  e.busy(false); e.pending(true); e.emit("agent_settled"); await flush();
  assert.equal(ends(h).length, 0);
  e.pending(false); e.emit("agent_settled"); await flush();
  assert.equal(ends(h).length, 1);
});

test("stop-only, session switch and reload preserve ownership with monotonic sequence", async () => {
  const h = host({ modules: { sessionStart: false, running: false, stop: true } });
  const e = h.extension(); e.emit("session_start"); start(e); e.emit("agent_settled"); await flush();
  e.emit("session_shutdown", { reason: "resume" }); e.session("resumed"); e.emit("session_start");
  start(e); e.emit("agent_settled"); await flush();
  e.emit("session_shutdown", { reason: "reload" });
  const reloaded = h.extension("resumed"); reloaded.emit("session_start"); start(reloaded);
  reloaded.emit("agent_settled"); await flush();
  assert.deepEqual(h.sent.map((x) => x.event), ["Stop", "Stop", "Stop"]);
  assert.deepEqual(h.sent.map((x) => x.sessionId), ["root", "resumed", "resumed"]);
  assert.deepEqual(h.sent.map((x) => x.pi.sequence), [1, 2, 3]);
  assert.equal(new Set(h.sent.map((x) => x.pi.instanceId)).size, 1);
});

test("重建扩展后接管旧租约：错误后 new/resume/fork/reload 均继续上报", async () => {
  for (const reason of ["new", "resume", "fork", "reload"]) {
    for (const reloadModule of [false, true]) {
      const h = host();
      const old = h.extension("first");
      old.emit("session_start"); start(old); result(old, "error");
      old.emit("agent_settled"); await flush();
      const failed = ends(h)[0];
      assert.equal(failed.event, "StopFailure");
      old.emit("session_shutdown", { reason });
      if (reloadModule) h.reloadModule();
      const nextId = reason === "reload" ? "first" : `${reason}-session`;
      const next = h.extension(nextId);
      next.emit("session_start", { reason });
      const rebound = h.sent.at(-1);
      assert.equal(rebound.event, "SessionStart", `${reason}, reloadModule=${reloadModule}`);
      assert.equal(rebound.sessionId, nextId);
      assert.equal(rebound.pi.instanceId, failed.pi.instanceId);
      assert.ok(rebound.pi.sequence > failed.pi.sequence);
      assert.ok(rebound.pi.runId > failed.pi.runId);
      // 包括同 ID reload：旧回调不得关闭新租约、改写结果或停止新会话。
      old.emit("session_start"); result(old, "error");
      old.emit("agent_settled"); old.emit("session_shutdown", { reason: "quit" });
      await flush();
      assert.equal(ends(h).length, 1);
      start(next); result(next, "stop"); next.emit("agent_settled"); await flush();
      assert.deepEqual(ends(h).map((event) => event.event), ["StopFailure", "Stop"]);
      assert.equal(ends(h)[1].sessionId, nextId);
      assert.equal(h.sent.filter((event) => event.event === "UserPromptSubmit").at(-1).sessionId, nextId);
      next.emit("session_shutdown", { reason: "quit" });
    }
  }
});

test("兼容复用 handler 的连续 new，且空会话不伪造运行事件", async () => {
  const h = host(); const e = h.extension(); e.emit("session_start");
  start(e); result(e, "error"); e.emit("agent_settled"); await flush();
  for (let index = 1; index <= 3; index += 1) {
    e.emit("session_shutdown", { reason: "new" });
    e.session(`new-${index}`);
    const before = h.sent.length;
    e.emit("session_start", { reason: "new" });
    assert.deepEqual(h.sent.slice(before).map((event) => event.event), ["SessionStart"]);
    assert.equal(h.sent.at(-1).sessionId, `new-${index}`);
    start(e); e.emit("agent_settled"); await flush();
    assert.equal(ends(h).at(-1).event, "Stop");
  }
  assert.equal(new Set(h.sent.map((event) => event.pi.sequence)).size, h.sent.length);
  e.emit("session_shutdown", { reason: "quit" });
});

test("连续重建后旧工厂即使遇到空租约也不能再次接管", async () => {
  for (const reloadModule of [false, true]) {
    const h = host();
    const old = h.extension("old"); old.emit("session_start");
    old.emit("session_shutdown", { reason: "new" });
    if (reloadModule) h.reloadModule();
    const next = h.extension("next"); next.emit("session_start");
    next.emit("session_shutdown", { reason: "new" });
    const before = h.sent.length;
    old.session("late-old"); old.emit("session_start"); start(old);
    await flush();
    assert.equal(h.sent.length, before, "旧工厂不能利用下一次切换的空窗重新认领");
    if (reloadModule) h.reloadModule();
    const current = h.extension("current"); current.emit("session_start"); start(current);
    result(current, "stop"); current.emit("agent_settled"); await flush();
    assert.equal(ends(h).at(-1).sessionId, "current");
    assert.equal(ends(h).at(-1).event, "Stop");
    current.emit("session_shutdown", { reason: "quit" });
  }
});

test("重新求值模块后只读等待序号不归零，旧 UI 结束不能撤销新等待", async () => {
  const h = host(); const old = h.extension(); old.emit("session_start"); start(old);
  old.emit("ui_prompt_start", { kind: "custom", title: "old" });
  old.emit("ui_prompt_end");
  old.emit("session_shutdown", { reason: "reload" });
  const previous = h.sent.filter((event) => event.terminalPrompt).at(-1);
  h.reloadModule();
  const next = h.extension(); next.emit("session_start", { reason: "reload" }); start(next);
  next.emit("ui_prompt_start", { kind: "custom", title: "new" });
  const current = h.sent.filter((event) => event.terminalPrompt).at(-1);
  assert.equal(current.terminalPrompt.instanceId, previous.terminalPrompt.instanceId);
  assert.ok(current.terminalPrompt.sequence > previous.terminalPrompt.sequence);
  const before = h.sent.length;
  old.emit("ui_prompt_end"); old.emit("ui_prompt_start", { kind: "custom", title: "late" });
  await flush();
  assert.equal(h.sent.length, before);
  next.emit("ui_prompt_end");
  assert.equal(h.sent.filter((event) => event.terminalPrompt).at(-1).terminalPrompt.active, false);
  next.emit("session_shutdown", { reason: "quit" });
});

test("旧会话问答 open 的响应迟到时只取消旧请求，不撤销新会话待答", async () => {
  // 本夹具仅延迟 /open 响应；请求是否已在真实 broker 内按序处理，需要独立验证。
  let releaseOldOpen;
  const cancelled = [];
  const opened = [];
  const pending = (body) => ({ ok: true, json: async () => ({
    status: "pending", brokerEpoch: "epoch", payload: { ...body, brokerEpoch: "epoch" },
  }) });
  const h = host({ fetchImpl: (init, url) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/open")) {
      opened.push(body);
      if (body.sessionId === "old") return new Promise((resolve) => { releaseOldOpen = () => resolve(pending(body)); });
      return pending(body);
    }
    if (url.endsWith("/cancel")) cancelled.push(body.requestId);
    return { ok: true, status: 204 };
  } });
  let finishOld;
  const oldUi = { select: () => new Promise((resolve) => { finishOld = resolve; }) };
  const old = h.extension("old", oldUi); old.emit("session_start"); start(old);
  const oldAnswer = oldUi.select("old question", ["A", "B"]);
  old.emit("session_shutdown", { reason: "new" });
  let finishNew;
  const newUi = { select: () => new Promise((resolve) => { finishNew = resolve; }) };
  const next = h.extension("new", newUi); next.emit("session_start"); start(next);
  const newAnswer = newUi.select("new question", ["A", "B"]);
  await flush();
  releaseOldOpen(); await flush();
  assert.equal(opened.length, 2);
  assert.ok(cancelled.includes(opened[0].requestId));
  assert.ok(!cancelled.includes(opened[1].requestId));
  finishOld("A"); finishNew("B");
  assert.equal(await oldAnswer, "A");
  assert.equal(await newAnswer, "B");
  next.emit("session_shutdown", { reason: "quit" });
});

test("旧镜像对话框迟到结束不减掉新会话的等待计数", async () => {
  const h = host();
  let finishOld;
  const oldUi = { select: () => new Promise((resolve) => { finishOld = resolve; }) };
  const old = h.extension("old", oldUi); old.emit("session_start"); start(old);
  // 超出可代答选项上限，专门覆盖原生镜像与心跳计数边界。
  const options = Array.from({ length: 65 }, (_, index) => `choice-${index}`);
  const oldAnswer = oldUi.select("old question", options);
  old.emit("session_shutdown", { reason: "new" });
  let finishNew;
  const newUi = { select: () => new Promise((resolve) => { finishNew = resolve; }) };
  const next = h.extension("new", newUi); next.emit("session_start"); start(next);
  const newAnswer = newUi.select("new question", options);
  const before = h.sent.length;
  finishOld(undefined); await oldAnswer;
  assert.equal(h.sent.length, before, "旧 finally 不得恢复新会话的工作心跳");
  finishNew(undefined); await newAnswer;
  assert.equal(h.sent.at(-1).event, "UserPromptSubmit");
  assert.equal(h.sent.at(-1).sessionId, "new");
  next.emit("session_shutdown", { reason: "quit" });
});

test("会话开始前的正式 shutdown 也交还工厂租约", async () => {
  for (const reason of ["new", "resume", "fork", "reload", "quit"]) {
    const h = host();
    const old = h.extension("unstarted");
    old.emit("session_shutdown", { reason });
    const next = h.extension("replacement");
    next.emit("session_start"); start(next); next.emit("agent_settled"); await flush();
    assert.equal(h.sent[0]?.event, "SessionStart", reason);
    assert.equal(ends(h)[0]?.sessionId, "replacement", reason);
    const before = h.sent.length;
    old.emit("session_start"); old.emit("session_shutdown", { reason: "quit" });
    assert.equal(h.sent.length, before);
    next.emit("session_shutdown", { reason: "quit" });
  }
});

test("旧心跳和只读续报在会话重建后失效，新计时器仍正常上报", async () => {
  for (const reloadModule of [false, true]) {
    const h = host();
    const old = h.extension("old"); old.emit("session_start"); start(old);
    const heartbeat = [...h.intervals.values()].find((timer) => timer.delay === 20_000);
    assert.ok(heartbeat);
    old.emit("ui_prompt_start", { kind: "custom", title: "old" });
    const prompt = [...h.intervals.values()].find((timer) => timer.delay === 5_000);
    assert.ok(prompt);
    assert.equal(h.intervals.size, 1, "正式等待挂起工作心跳");
    old.emit("session_shutdown", { reason: "new" });
    assert.equal(h.intervals.size, 0);
    if (reloadModule) h.reloadModule();
    const next = h.extension("new"); next.emit("session_start"); start(next);
    next.emit("ui_prompt_start", { kind: "custom", title: "new" });
    const before = h.sent.length;
    heartbeat.callback(); prompt.callback(); await flush();
    assert.equal(h.sent.length, before, "旧计时器不能使用新实例的身份上报");
    const current = [...h.intervals.values()].find((timer) => timer.delay === 5_000);
    assert.ok(current);
    current.callback();
    assert.equal(h.sent.at(-1).sessionId, "new");
    assert.equal(h.sent.at(-1).terminalPrompt.active, true);
    next.emit("ui_prompt_end");
    assert.equal([...h.intervals.values()][0]?.delay, 20_000);
    next.emit("session_shutdown", { reason: "quit" });
    assert.equal(h.intervals.size, 0);
  }
});

test("部分关闭的模块重建后保持原开关语义，空会话不产生终态", async () => {
  for (const modules of [
    { sessionStart: true, running: false, stop: false },
    { sessionStart: false, running: true, stop: false },
    { sessionStart: false, running: false, stop: true },
    { sessionStart: false, running: false, stop: false },
  ]) {
    const h = host({ modules });
    const old = h.extension("old"); old.emit("session_start"); start(old);
    old.emit("agent_settled"); await flush();
    old.emit("session_shutdown", { reason: "new" });
    const before = h.sent.length;
    const next = h.extension("new"); next.emit("session_start");
    next.emit("agent_settled"); await flush();
    assert.deepEqual(h.sent.slice(before).map((event) => event.event), modules.sessionStart ? ["SessionStart"] : []);
    start(next); next.emit("agent_settled"); await flush();
    const expected = [
      ...(modules.sessionStart ? ["SessionStart"] : []),
      ...(modules.running ? ["UserPromptSubmit"] : []),
      ...(modules.stop ? ["Stop"] : []),
    ];
    assert.deepEqual(h.sent.slice(before).map((event) => event.event), expected);
    assert.ok(h.sent.slice(before).every((event) => event.sessionId === "new"));
    next.emit("session_shutdown", { reason: "quit" });
  }
});

test("incomplete callback environment stays silent", async () => {
  const h = host({ env: { CLI_MANAGER_NOTIFY_TOKEN: "" } });
  const e = h.extension(); e.emit("session_start"); start(e); e.emit("agent_settled");
  await flush(); assert.equal(h.sent.length, 0);
});

test("bridge errors and a stalled request never block lifecycle callbacks; timeout aborts delivery", async () => {
  const failed = host({ fetchImpl: async () => { throw new Error("offline"); } });
  const first = failed.extension();
  assert.equal(first.emit("session_start"), undefined);
  start(first); first.emit("agent_settled"); await flush();
  let aborted = 0;
  const stalled = host({ fetchImpl: ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted += 1; reject(new Error("aborted")); }, { once: true });
  }) });
  const second = stalled.extension();
  assert.equal(second.emit("session_start"), undefined);
  // fork 模板保留 2 秒请求超时（上游 1 秒），等待超过它即可观察到一次 abort。
  await new Promise((resolve) => setTimeout(resolve, 2_050));
  assert.equal(aborted, 1);
});
