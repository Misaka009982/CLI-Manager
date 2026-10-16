import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("../src/shared/lib/desktopPetETerminalPrompt.ts");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  fileName: "desktopPetETerminalPrompt.ts",
}).outputText;
const state = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
const start = 1_000_000;
const key = state.desktopPetETerminalPromptScopeKey("tab-1", "pi-1");
const empty = () => state.createDesktopPetETerminalPromptState();
const selected = (current, now) => state.selectDesktopPetETerminalPrompts(current, now);

// 报告的时间是发出时间，接收时间独立传给 reducer，避免测试把重播当作续期。
function report(sequence, sentAt, prompt = {}, extra = {}) {
  return {
    tabId: "tab-1", source: "pi", event: "DesktopPetEUiPrompt", sessionId: "pi-1",
    timestamp: new Date(sentAt).toISOString(), remoteEventId: `event-${sequence}`,
    terminalPrompt: {
      instanceId: "instance-1", id: "prompt-1", sequence, active: true,
      kind: "custom", title: "选择方案", ...prompt,
    },
    ...extra,
  };
}

function apply(current, sequence, sentAt, prompt = {}, extra = {}, receivedAt = sentAt) {
  return state.reduceDesktopPetETerminalPrompt(current, report(sequence, sentAt, prompt, extra), receivedAt);
}

function lifecycle(event, sentAt, extra = {}) {
  return {
    source: "pi", tabId: "tab-1", sessionId: "pi-1", event,
    timestamp: new Date(sentAt).toISOString(), ...extra,
  };
}

test("正式区间续报保留同一展示对象和开始时间，长期等待不会过期", () => {
  let current = apply(empty(), 1, start);
  const first = selected(current, start);
  const prompt = first.get(key);
  assert.equal(prompt.kind, "custom");
  assert.equal(prompt.startedAt, start);
  for (let sequence = 2; sequence <= 40; sequence += 1) {
    const now = start + (sequence - 1) * 5_000;
    current = apply(current, sequence, now);
    const next = selected(current, now);
    assert.equal(next.get(key), prompt);
    assert.equal(state.sameDesktopPetETerminalPrompts(first, next), true);
    assert.equal(state.nextDesktopPetETerminalPromptExpiry(current, now), now + 30_000);
  }
});

test("复合区间身份无碰撞，合法边界标识不因转义超过任务 ID 上限", () => {
  const first = selected(apply(empty(), 1, start, { instanceId: "a", id: "bc" }), start).get(key);
  const second = selected(apply(empty(), 1, start, { instanceId: "ab", id: "c" }), start).get(key);
  assert.notEqual(first.id, second.id);
  const maximum = selected(apply(empty(), 1, start, { instanceId: '"'.repeat(128), id: '"'.repeat(128) }), start).get(key);
  assert.ok(maximum.id.length <= 260);
});

test("租期以发出时间计算，缓存重播和重复包不能延长黄灯", () => {
  const first = apply(empty(), 1, start);
  const delayed = apply(first, 2, start + 5_000, {}, {}, start + 20_000);
  assert.equal(selected(delayed, start + 34_999).size, 1);
  assert.equal(selected(delayed, start + 35_000).size, 0);
  assert.equal(state.nextDesktopPetETerminalPromptExpiry(delayed, start + 35_000), Infinity);
  assert.equal(apply(delayed, 2, start + 20_000), delayed);
  assert.equal(apply(delayed, 3, start + 6_000, {}, {}, start + 40_000), delayed);
  const renewed = apply(delayed, 4, start + 40_001);
  assert.equal(selected(renewed, start + 40_001).get(key), selected(first, start).get(key));
});

test("重复与乱序按实例序号及时间拒绝，结束后不能复活旧区间", () => {
  const first = apply(empty(), 1, start);
  const newer = apply(first, 3, start + 10_000);
  assert.equal(apply(newer, 2, start + 5_000, {}, {}, start + 10_000), newer);
  assert.equal(apply(newer, 3, start + 15_000), newer);
  assert.equal(apply(newer, 4, start + 9_000, {}, {}, start + 10_000), newer);
  const ended = apply(newer, 4, start + 15_000, { active: false });
  assert.equal(selected(ended, start + 15_000).size, 0);
  assert.equal(apply(ended, 5, start + 20_000), ended);
  const next = apply(ended, 6, start + 25_000, { id: "prompt-2" });
  assert.equal(selected(next, start + 25_000).size, 1);
});

test("先收到结束再收到开始时不显示等待，旧结束不能撤销新等待", () => {
  const ended = apply(empty(), 2, start + 5_000, { active: false });
  assert.equal(apply(ended, 1, start, {}, {}, start + 5_000), ended);
  const next = apply(ended, 3, start + 10_000, { id: "prompt-2" });
  const prompt = selected(next, start + 10_000).get(key);
  assert.equal(apply(next, 2, start + 5_000, { active: false }, {}, start + 10_000), next);
  const lateEnd = apply(next, 4, start + 15_000, { active: false });
  assert.equal(selected(lateEnd, start + 15_000).get(key), prompt);
  assert.equal(apply(lateEnd, 3, start + 16_000), lateEnd);
});

test("新实例接管后拒绝旧实例的续报和结束，多会话互不串联", () => {
  let current = apply(empty(), 20, start);
  current = apply(current, 1, start + 5_000, { instanceId: "instance-2" });
  const fresh = selected(current, start + 5_000).get(key);
  assert.equal(apply(current, 99, start + 10_000), current);
  assert.equal(apply(current, 100, start + 10_000, { active: false }), current);
  current = apply(current, 1, start + 10_000, {}, { tabId: "tab-2", sessionId: "pi-2" });
  assert.equal(selected(current, start + 10_000).size, 2);
  assert.equal(selected(current, start + 10_000).get(key), fresh);
  current = apply(current, 2, start + 15_000, { active: false }, { tabId: "tab-2", sessionId: "pi-2" });
  assert.equal(selected(current, start + 15_000).size, 1);
  assert.equal(selected(current, start + 15_000).get(key), fresh);
  assert.notEqual(state.desktopPetETerminalPromptScopeKey("a:b", "c"), state.desktopPetETerminalPromptScopeKey("a", "b:c"));
});

test("生命周期只清理来源、Tab、会话和时间匹配的等待，心跳不是完成证据", () => {
  for (const event of ["SessionStart", "Stop", "Interrupt", "StopFailure"]) {
    let current = apply(empty(), 1, start);
    const prompt = selected(current, start).get(key);
    for (const extra of [{ source: "claude" }, { tabId: "other" }, { sessionId: "other" }, { agentId: "child" }]) {
      current = state.reduceDesktopPetETerminalPrompt(current, lifecycle(event, start + 5_000, extra), start + 5_000);
      assert.equal(selected(current, start + 5_000).get(key), prompt);
    }
    current = state.reduceDesktopPetETerminalPrompt(current, lifecycle(event, start - 1), start + 5_000);
    assert.equal(selected(current, start + 5_000).get(key), prompt);
    for (const ordinary of ["UserPromptSubmit", "Notification", "ToolStop", "AgentToolStop"]) {
      const next = state.reduceDesktopPetETerminalPrompt(current, lifecycle(ordinary, start + 6_000), start + 6_000);
      assert.equal(next, current);
    }
    current = state.reduceDesktopPetETerminalPrompt(current, lifecycle(event, start + 10_000), start + 10_000);
    assert.equal(selected(current, start + 10_000).has(key), false);
    assert.equal(apply(current, 2, start + 15_000), current);
  }
});

test("重启时间下界拒绝旧缓存，新续报仍可恢复", () => {
  const reset = state.createDesktopPetETerminalPromptState(start + 10_000);
  assert.equal(apply(reset, 1, start + 5_000, {}, {}, start + 10_000), reset);
  assert.equal(apply(reset, 2, start + 10_000), reset);
  assert.equal(selected(apply(reset, 3, start + 15_000), start + 15_000).size, 1);
});

test("拒绝缺失身份、非法种类序号标题和非本地 Pi 载荷", () => {
  const invalidPrompts = [
    { instanceId: "" }, { id: "bad\n" }, { id: "x".repeat(129) }, { sequence: 0 },
    { sequence: -1 }, { sequence: 1.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { active: "true" }, { kind: "question" }, { title: "问".repeat(513) },
    { title: "line\nline" }, { unexpected: true },
  ];
  for (const prompt of invalidPrompts) assert.equal(selected(apply(empty(), 1, start, prompt), start).size, 0);
  const invalidPayloads = [
    { source: "claude" }, { source: null }, { sessionId: "" }, { tabId: " tab" },
    { remoteEventId: "" }, { timestamp: "not-a-time" }, { environmentType: "ssh" },
    { remoteHostId: "host" }, { remoteProjectId: "project" }, { remoteSequence: 1 },
    { hookInput: {} }, { toolName: "question" }, { agentId: "child" },
    { event: "Notification" }, { terminalPrompt: null },
  ];
  for (const extra of invalidPayloads) assert.equal(selected(apply(empty(), 1, start, {}, extra), start).size, 0);
  const future = state.reduceDesktopPetETerminalPrompt(empty(), report(1, start + 5_001), start);
  assert.equal(selected(future, start).size, 0);
  assert.equal(selected(apply(empty(), 1, start, {}, {}, start + 30_000), start + 30_000).size, 0);
  const valid = apply(empty(), Number.MAX_SAFE_INTEGER, start, { title: "问".repeat(512) }, { wslDistroName: "Ubuntu" });
  assert.equal(selected(valid, start).size, 1);
});

test("作用域与实例游标有界，淘汰不会重新接纳旧包", () => {
  let current = empty();
  const limit = state.DESKTOP_PET_E_TERMINAL_PROMPT_MAX_SCOPES;
  for (let index = 0; index <= limit; index += 1) {
    current = apply(current, 1, start + index, {}, { tabId: `tab-${index}` });
  }
  assert.equal(current.scopes.size, limit);
  assert.equal(apply(current, 1, start, {}, { tabId: "tab-0" }, start + limit), current);
  current = apply(current, 2, start + limit + 1, {}, { tabId: "tab-0" });
  assert.equal(current.scopes.size, limit);
  let reloaded = apply(empty(), 1, start);
  for (let index = 2; index <= 30; index += 1) {
    reloaded = apply(reloaded, 1, start + index, { instanceId: `instance-${index}` });
  }
  assert.equal(reloaded.scopes.get(key).retiredInstances.length, 16);
  assert.equal(apply(reloaded, 100, start + 100), reloaded);
});

test("上游入口仅识别私有事件标签，不把完整载荷类型混入普通 Hook", () => {
  assert.equal(state.isDesktopPetEUiPromptEvent({ event: "DesktopPetEUiPrompt" }), true);
  assert.equal(state.isDesktopPetEUiPromptEvent({ event: "Notification" }), false);
  assert.equal(state.isDesktopPetEUiPromptEvent(null), false);
  assert.equal(state.isDesktopPetEUiPromptEvent([]), false);
});

test("跨层专用事件只广播，不进入答题、普通状态、Replay 和通知", () => {
  const hook = read("../src-tauri/src/features/hooks/claude.rs");
  const guard = read("../src-tauri/src/features/hooks/desktop_pet_e_ui_prompt.rs");
  const daemon = read("../src-tauri/src/infrastructure/daemon/server.rs");
  const app = read("../src/app/App.tsx");
  const coordinator = read("../src/features/terminal/hooks/useDesktopPetETerminalPrompts.ts");
  const types = read("../src/features/terminal/types/terminalStoreTypes.ts");
  assert.match(hook, /desktop_pet_e_ui_prompt::is_valid\(payload\)/);
  assert.match(hook, /terminal_prompt: payload\.terminal_prompt/);
  assert.match(hook, /desktop_pet_e_ui_prompt::route\(payload, &delivery, \|payload\| arbiter\.submit\(payload\)\)/);
  assert.match(guard, /if payload\.is_desktop_pet_e_ui_prompt\(\) \{\s*delivery\(payload\);\s*\} else \{\s*ordinary\(payload\);/);
  assert.match(guard, /deny_unknown_fields/);
  assert.match(guard, /payload\.hook_input\.is_none\(\)/);
  assert.match(guard, /payload\.remote_host_id\.is_none\(\)/);
  assert.match(guard, /pub fn dispatch_desktop_pet_e_ui_prompt/);
  assert.match(guard, /serde_json::to_value\(self\)/);
  assert.doesNotMatch(guard, /DesktopPetEAgentBroker|observe_hook/);
  const delivery = daemon.slice(daemon.indexOf("if payload.dispatch_desktop_pet_e_ui_prompt("));
  const dedicated = delivery.slice(0, delivery.indexOf("return;"));
  assert.match(dedicated, /broadcast_hook\(value\)/);
  assert.doesNotMatch(dedicated, /observe_hook|update_task_status|try_enqueue|maybe_activate_app/);
  assert.ok(delivery.indexOf("return;") < delivery.indexOf("maybe_activate_app_for_hook"));
  const listener = app.slice(app.indexOf("const unlistenHook = listen<"));
  const excluded = listener.indexOf("if (isDesktopPetEUiPromptEvent(payload)) return;");
  assert.ok(excluded >= 0 && excluded < listener.indexOf("resolveCliHookStatus(payload)"));
  assert.doesNotMatch(types, /DesktopPetEUiPrompt|terminalPrompt/);
  assert.doesNotMatch(coordinator, /notificationsEnabled|agentInteractionEnabled|invoke\(|useDesktopPetEAgentStore/);
  assert.match(coordinator, /cli-manager-pty-daemon-restarted/);
  assert.match(coordinator, /sameDesktopPetETerminalPrompts\(current, next\) \? current : next/);
  assert.match(coordinator, /nextDesktopPetETerminalPromptExpiry/);
});
