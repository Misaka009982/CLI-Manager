import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
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

// 可在同一测试上运行修改前的生成模板，证明回归用例确实覆盖旧行为。
function sourceFor(modules) {
  if (process.env.PI_HOOK_BASELINE === "1") {
    const rust = execFileSync("git", ["show", "HEAD:src-tauri/src/features/hooks/settings/pi.rs"], { encoding: "utf8" });
    return rust.match(/r#"(\/\/ \{marker\}[\s\S]*?)"#,\s*marker =/)[1]
      .replaceAll("{marker}", "__CLI_MANAGER_PI_HOOK__")
      .replaceAll("{session_start}", String(modules.sessionStart))
      .replaceAll("{running}", String(modules.running))
      .replaceAll("{stop}", String(modules.stop)).replaceAll("{{", "{").replaceAll("}}", "}");
  }
  return piTemplate()
    .replaceAll("__PI_SESSION_START__", String(modules.sessionStart))
    .replaceAll("__PI_RUNNING__", String(modules.running))
    .replaceAll("__PI_STOP__", String(modules.stop));
}

// 只有 fetch 为内存桩；模板真实编译/执行，根与子进程用独立 JS realm 模拟环境继承。
function host({ env = {}, pid = 100, modules = { sessionStart: true, running: true, stop: true }, fetchImpl } = {}) {
  const sent = [];
  const environment = {
    CLI_MANAGER_TAB_ID: "parent-tab", CLI_MANAGER_NOTIFY_PORT: "1234",
    CLI_MANAGER_NOTIFY_TOKEN: "test-token", ...env,
  };
  const context = vm.createContext({
    exports: {}, require: requireStub, crypto: { randomUUID },
    process: { pid, env: environment, cwd: () => "/workspace" },
    AbortController, setTimeout, clearTimeout,
    // 不创建真实心跳计时器；生命周期用例只检查显式触发的上报。
    setInterval: () => 1, clearInterval: () => {},
    fetch: async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return fetchImpl ? fetchImpl(init) : { ok: true };
    },
  });
  const code = ts.transpileModule(sourceFor(modules), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInContext(code, context);
  function extension(sessionId = "root") {
    const handlers = new Map();
    let currentSession = sessionId;
    let idle = true;
    let pending = false;
    const ctx = {
      sessionManager: { getSessionId: () => currentSession },
      isIdle: () => idle, hasPendingMessages: () => pending,
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
  return { sent, env: environment, extension };
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
