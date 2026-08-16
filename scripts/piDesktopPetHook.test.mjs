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
  assert.match(template, /CLI_MANAGER_PI_EXTENSION_VERSION:2/);
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

test("questions preserve ordered groups and keep native TUI fallback", () => {
  assert.match(template, /requestDecision\(\s*"questionnaire"/);
  assert.match(template, /decision\.answers\.length !== questions\.length/);
  assert.match(template, /nativeQuestionnaire\(questions, ctx\)/);
  assert.match(template, /Error: No options provided/);
  assert.match(template, /Error: UI not available \(running in non-interactive mode\)/);
  assert.match(template, /user selected: \$\{answer\.index\}/);
  assert.match(template, /user wrote: \$\{answer\.label\}/);
  assert.match(template, /seen = new Set<string>\(\)/);
  assert.match(template, /answer\.wasCustom/);
  assert.match(template, /ctx\.ui\.select/);
  assert.match(template, /ctx\.ui\.input/);
  assert.match(template, /decision bridge disconnected; returning to Pi's native prompt/);
  assert.match(template, /details: \{ questions, answers, cancelled: false \}/);
});

test("Pi permission bridge observes only the explicit producer", () => {
  assert.match(template, /event\.toolName !== "cli_manager_permission"/);
  assert.match(template, /pi\.on\("tool_call", permissionDecision\)/);
  assert.doesNotMatch(template, /event\.toolName === "bash"|event\.toolName === "read"/);
  assert.match(template, /Permission unresolved; request it again when ready/);
});

test("heartbeat and shutdown cleanup preserve lifecycle status", () => {
  assert.match(template, /HEARTBEAT_INTERVAL_MS = 20_000/);
  assert.match(template, /nextEventTimestampMs/);
  assert.match(template, /stopHeartbeat\(\)/);
  assert.match(template, /pi\.on\("session_shutdown"/);
  assert.match(template, /"StopFailure"/);
  assert.match(hookServer, /"SessionStart" \| "UserPromptSubmit" \| "Stop" \| "StopFailure"/);
});
