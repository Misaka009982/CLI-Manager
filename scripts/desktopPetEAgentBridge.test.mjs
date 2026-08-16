import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const broker = readFileSync(new URL("../src-tauri/src/desktop_pet_e_agent.rs", import.meta.url), "utf8");
const hookClient = readFileSync(new URL("../src-tauri/src/hook_client.rs", import.meta.url), "utf8");
const hookServer = readFileSync(new URL("../src-tauri/src/claude_hook.rs", import.meta.url), "utf8");
const hookSettings = readFileSync(new URL("../src-tauri/src/commands/hook_settings.rs", import.meta.url), "utf8");
const proxy = readFileSync(new URL("../src-tauri/src/codex_app_server_proxy.rs", import.meta.url), "utf8");
const coordinator = readFileSync(new URL("../src/hooks/useDesktopPetECoordinator.ts", import.meta.url), "utf8");
const sessionCoordinator = readFileSync(new URL("../src/hooks/useDesktopPetEAgentCoordinator.ts", import.meta.url), "utf8");
const sharedAgentStore = readFileSync(new URL("../src/stores/desktopPetEAgentStore.ts", import.meta.url), "utf8");
const sessionPanel = readFileSync(new URL("../src/components/terminal/DesktopPetESessionActionPanel.tsx", import.meta.url), "utf8");
const terminalTabs = readFileSync(new URL("../src/components/TerminalTabs.tsx", import.meta.url), "utf8");
const terminalStore = readFileSync(new URL("../src/stores/terminalStore.ts", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

test("pending-action broker is bounded, authenticated, and lease-gated", () => {
  assert.match(broker, /DESKTOP_PET_E_AGENT_MAX_BODY_BYTES: usize = 1024 \* 1024/);
  assert.match(broker, /MAX_PENDING_ACTIONS: usize = 128/);
  assert.match(broker, /AVAILABILITY_LEASE/);
  assert.match(broker, /Condvar/);
  assert.match(hookServer, /Authorization/);
  assert.match(hookServer, /DesktopPetEAgentBroker::is_agent_path/);
  assert.doesNotMatch(broker, /TcpListener/);
});

test("submission keeps transport identity until protocol acknowledgement", () => {
  assert.match(broker, /transport_action_id/);
  assert.match(broker, /PendingState::Submitted/);
  assert.match(broker, /remember_completed/);
  assert.match(broker, /\.completed\s*\.values\(\)\s*\.find/);
  assert.match(broker, /desktop_pet_e_agent_transport_mismatch/);
  assert.match(broker, /transport_action_id == &request\.transport_action_id/);
  assert.match(broker, /pending_transport_action_id/);
  assert.match(broker, /"submitted"/);
  assert.match(broker, /"resolved"/);
  assert.match(broker, /"failed"/);
  assert.match(sharedAgentStore, /desktop_pet_e_agent_submit/);
  assert.match(coordinator, /useDesktopPetEAgentStore\.getState\(\)\.submit/);
  assert.match(sessionPanel, /await submit\(\{/);
  assert.match(coordinator, /desktop_pet_e_action_result/);
  assert.match(coordinator, /confirmed: false/);
  assert.match(coordinator, /confirmed: true/);
});

test("pet and owning session share pending actions without lifecycle cancellation", () => {
  assert.match(app, /useDesktopPetEAgentCoordinator\(startupReady\)/);
  assert.match(sessionCoordinator, /cli-manager-session-ui-/);
  assert.match(sessionCoordinator, /DESKTOP_PET_E_AGENT_EVENT/);
  assert.match(sessionCoordinator, /desktop_pet_e_agent_availability/);
  assert.match(sessionCoordinator, /desktopPetEEnabled \|\| runtimeFailureGrace \|\| hasInteractivePendingActions/);
  assert.match(sessionCoordinator, /RUNTIME_FAILURE_AVAILABILITY_GRACE_MS = 15_000/);
  assert.match(sessionCoordinator, /attachDaemonSession\(sessionId, \{ activate: false \}\)/);
  assert.match(sessionCoordinator, /currentAction\?\.id !== pendingActionId/);
  assert.match(sessionCoordinator, /reason: "owning-session-unavailable"/);
  assert.match(terminalStore, /activate\?: boolean/);
  assert.match(terminalStore, /setPaneActiveSession\(paneResult\.tree, targetWorkspan\.activeSessionId\)/);
  assert.match(sharedAgentStore, /requestGeneration < cursor\.requestGeneration/);
  assert.match(sharedAgentStore, /cursor\.closed && cursor\.pendingActionId/);
  assert.match(coordinator, /state\) => state\.pendingActions/);
  assert.match(sessionPanel, /state\) => state\.submit/);
  assert.match(sessionPanel, /desktopPetE\.agentInteractionEnabled/);
  assert.match(sessionPanel, /reason="desktopPetE\.agent\.adapterUnavailable"/);
  assert.match(sessionPanel, /serializeAnswers\(action, draft\)/);
  assert.match(sessionPanel, /type="radio"/);
  assert.match(sessionPanel, /type="checkbox"/);
  assert.match(sessionPanel, /<textarea/);
  assert.match(sessionPanel, /setCollapsed/);
  assert.match(sessionPanel, /aria-expanded=\{!collapsed\}/);
  assert.match(terminalTabs, /DesktopPetESessionActionPanel sessionId=\{session\.id\}/);
  assert.match(terminalTabs, /next\[sessionId\] = "attention"/);
  assert.match(terminalTabs, /for \(const sessionId of pendingActions\.keys\(\)\)[\s\S]*next\.add\(sessionId\)/);
  assert.doesNotMatch(coordinator, /desktop_pet_e_agent_cancel/);
  assert.doesNotMatch(coordinator, /pet-interaction-unavailable|pet-closed|terminal-fallback/);
});

test("Claude command hooks wait for native output and preserve official decision fields", () => {
  assert.match(hookClient, /try_interactive_decision/);
  assert.match(hookClient, /request_desktop_pet_e_agent/);
  assert.match(hookClient, /Duration::from_secs\(590\)/);
  assert.match(hookSettings, /build_command\(exe, "claude", "PermissionRequest"\),\s*600/);
  assert.match(hookSettings, /build_command\(exe, "codex", "PermissionRequest"\),\s*600/);
  assert.match(hookClient, /stdout\.lock\(\)/);
  assert.match(hookClient, /write_all\(&output\)/);
  assert.match(hookClient, /"cancelled" \| "expired" \| "unavailable" => return Ok\(None\)/);
  assert.match(broker, /"hookEventName": "PermissionRequest"/);
  assert.match(broker, /"updatedInput": updated_input/);
  assert.match(broker, /"updatedPermissions": \[suggestion\]/);
  assert.doesNotMatch(broker, /"behavior": if allow/);
});

test("question notifications degrade to jump-only without becoming normal notifications", () => {
  assert.match(hookClient, /fn is_question_event/);
  assert.match(hookClient, /AskUserQuestion/);
  assert.match(hookClient, /request_user_input/);
  assert.match(hookServer, /question_event/);
  assert.match(hookServer, /"notification-only"/);
  assert.match(broker, /codex_hook_questions/);
  assert.match(broker, /desktopPetE\.agent\.notificationOnly/);
});

test("Codex app-server requests keep native ids and share one synchronized stdin", () => {
  for (const method of [
    "tool/requestUserInput",
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "mcpServer/elicitation/request",
    "applyPatchApproval",
    "execCommandApproval",
  ]) {
    assert.match(proxy, new RegExp(method.replaceAll("/", "\\/")));
  }
  assert.match(proxy, /Arc::new\(Mutex::new/);
  assert.match(proxy, /std::thread::spawn/);
  assert.match(proxy, /first_protocol_string/);
  assert.match(proxy, /write_parent_line\(&parent_output, &original_line\)/);
  assert.match(proxy, /request_desktop_pet_e_agent/);
  assert.match(proxy, /acknowledge_desktop_pet_e_agent/);
  assert.match(broker, /"requestId": request_id/);
  assert.match(broker, /"jsonrpc": "2\.0", "id": id, "result": result/);
  assert.match(broker, /"answers": answers/);
  assert.match(broker, /mcp_answer_value/);
});
