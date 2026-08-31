import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const template = readFileSync(new URL("../src-tauri/src/pi_extension_template.ts", import.meta.url), "utf8");
const hookSettings = readFileSync(new URL("../src-tauri/src/commands/hook_settings.rs", import.meta.url), "utf8");
const broker = readFileSync(new URL("../src-tauri/src/desktop_pet_e_agent.rs", import.meta.url), "utf8");
const hookServer = readFileSync(new URL("../src-tauri/src/claude_hook.rs", import.meta.url), "utf8");

test("managed Pi extension is generated from the owned decision template", () => {
  assert.match(hookSettings, /include_str!\("\.\.\/pi_extension_template\.ts"\)/);
  assert.match(template, /__CLI_MANAGER_PI_HOOK__|__PI_MARKER__/);
  assert.match(template, /CLI_MANAGER_PI_EXTENSION_VERSION:6/);
  assert.match(hookSettings, /PI_EXTENSION_VERSION_PREFIX/);
  assert.match(hookSettings, /pi_extension_version\(&content\)\.unwrap_or_default\(\) < PI_EXTENSION_VERSION/);
  assert.match(hookSettings, /managed_legacy_pi_extension_is_upgraded_in_place/);
  assert.match(hookSettings, /future_managed_pi_extension_is_not_downgraded/);
  assert.match(template, /pi\.getAllTools\(\)/);
  assert.match(template, /tools\.find\(\(tool\) => tool\.name === "question"\)/);
  assert.match(template, /tools\.find\(\(tool\) => tool\.name === "questionnaire"\)/);
  assert.match(template, /isQuestionToolCompatible/);
  assert.match(template, /isQuestionnaireToolCompatible/);
  assert.doesNotMatch(template, /before_agent_start/);
});

test("Pi decision loop opens, polls, acknowledges, and cancels by broker epoch", () => {
  for (const endpoint of ["open", "poll", "ack", "cancel"]) {
    assert.match(template, new RegExp(`/api/pi-decision/${endpoint}`));
    assert.match(broker, new RegExp(`\\"/api/pi-decision/${endpoint}\\"`));
  }
  assert.match(template, /brokerEpoch/);
  assert.match(template, /sourceInstanceId/);
  assert.match(template, /pendingDecisions/);
  assert.match(template, /cancelPendingDecisions/);
  assert.match(broker, /PI_DECISION_BROKER_EPOCH/);
  assert.match(broker, /pi_answer_from_response/);
  assert.match(broker, /status": "accepted"/);
});

test("pet and Pi terminal race for the same decision and cancel the loser", () => {
  // 宠物端与终端原生提示同时呈现，谁先回答谁生效，另一侧靠 abort 自动收起并清除。
  assert.match(template, /function raceDecisionSurfaces/);
  assert.match(template, /kind: "bridge"/);
  assert.match(template, /kind: "native"/);
  assert.match(template, /new AbortController\(\)/);
  assert.match(template, /controller\.abort\(\);[\s\S]*resolve\(result\)/);
  assert.match(template, /raceSignal\.aborted \? null/);
  // question / questionnaire 的终端一侧改为自绘面板：ctx.ui.select 只接受字符串数组，
  // 无法展示每个选项的说明，模型给出的推荐理由会在终端里丢失。
  assert.match(template, /showQuestionSurface\(\[\{/);
  assert.match(template, /showQuestionSurface\(\s*questions\.map/);
  assert.match(template, /ctx\.ui\.select\(message, \["Allow", "Deny"\], skipMirror\(raceSignal\)\)/);
  // 原生一侧先赢时，requestDecision 的 finally 会向 broker 发 cancel 清掉宠物端待处理项。
  assert.match(template, /if \(!acknowledged\) \{[\s\S]*pi-decision\/cancel/);
});

test("third-party Pi dialogs mirror to the pet as a notification only", () => {
  // permission-gate 等扩展直接调 ctx.ui，宠物端无法代答，只镜像成提醒。
  // Pi 0.84.4+ 提供官方 ui_prompt 事件，优先走它；老版本靠改写 ctx.ui 的兜底补丁。
  assert.match(template, /pi\.on\("ui_prompt_start"/);
  assert.match(template, /pi\.on\("ui_prompt_end"/);
  assert.match(template, /registerPromptEvents\(pi\)/);
  assert.match(template, /officialPromptEvents = true/);
  assert.match(template, /postHook\("Notification", dialogNotice\(event\.kind, event\.title\)\)/);
  // 官方区间用布尔量配平，不在结束时重新判断 ownDialogs，否则心跳可能永久挂起。
  assert.match(template, /officialSpanMirrored/);
  assert.match(template, /function installDialogMirror/);
  assert.match(template, /\["select", "confirm", "input"\] as DialogKind\[\]/);
  assert.match(template, /DIALOG_MIRROR_SKIP/);
  assert.match(template, /DIALOG_MIRROR_INSTALLED/);
  // 兜底通知延后发：官方事件先到就不重复发，避开双份提醒。
  assert.match(template, /DIALOG_MIRROR_FALLBACK_MS/);
  assert.match(template, /if \(!officialPromptEvents\) void postHook\("Notification", dialogNotice\(kind, args\[0\]\)\)/);
  assert.match(template, /installDialogMirror\(ctx\)/);
  // 镜像期间挂起心跳，否则 20 秒一次的 UserPromptSubmit 会把「需要关注」刷回「运行中」。
  assert.match(template, /function beginMirroredDialog/);
  assert.match(template, /function endMirroredDialog/);
  assert.match(template, /heartbeatRunning/);
  assert.match(template, /suspendHeartbeatForLifecycle\(\)/);
  assert.match(hookServer, /"SessionStart" \| "UserPromptSubmit" \| "Notification" \| "Stop" \| "StopFailure"/);
});

test("questions preserve ordered groups and keep native TUI fallback", () => {
  assert.match(template, /requestDecision\(\s*"questionnaire"/);
  assert.match(template, /decision\.answers\.length !== questions\.length/);
  assert.match(template, /nativeQuestionnaire\(questions, ctx, signal\)/);
  assert.match(template, /Error: No options provided/);
  assert.match(template, /Error: UI not available \(running in non-interactive mode\)/);
  assert.match(template, /user selected: \$\{answer\.index\}/);
  assert.match(template, /user wrote: \$\{answer\.label\}/);
  assert.match(template, /seen = new Set<string>\(\)/);
  assert.match(template, /answer\.wasCustom/);
  assert.match(template, /ctx\.ui\.select/);
  // 自定义答案走自绘面板内嵌的 Editor，不再弹第二个 ctx.ui.input 对话框。
  assert.match(template, /const SURFACE_OTHER_LABEL = "Type something\."/);
  assert.match(template, /editor\.onSubmit = \(value\) =>/);
  assert.match(template, /decision bridge disconnected; returning to Pi's native prompt/);
  assert.match(template, /details: \{ questions, answers, cancelled: false \}/);
});

test("Pi permission bridge observes only the explicit producer", () => {
  assert.match(template, /event\.toolName !== "cli_manager_permission"/);
  assert.match(template, /pi\.on\("tool_call", permissionDecision\)/);
  assert.doesNotMatch(template, /event\.toolName === "bash"|event\.toolName === "read"/);
  assert.match(template, /Permission remains unresolved; request it again when ready/);
});

test("heartbeat and shutdown cleanup preserve lifecycle status", () => {
  assert.match(template, /HEARTBEAT_INTERVAL_MS = 20_000/);
  assert.match(template, /nextEventTimestampMs/);
  assert.match(template, /stopHeartbeat\(\)/);
  assert.match(template, /pi\.on\("session_shutdown"/);
  assert.match(template, /"StopFailure"/);
  assert.match(hookServer, /"SessionStart" \| "UserPromptSubmit" \| "Stop" \| "StopFailure"/);
});
