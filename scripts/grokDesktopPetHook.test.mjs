import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const hookClient = readFileSync(new URL("../src-tauri/src/hook_client.rs", import.meta.url), "utf8");
const hookServer = readFileSync(new URL("../src-tauri/src/claude_hook.rs", import.meta.url), "utf8");
const hookSettings = readFileSync(new URL("../src-tauri/src/commands/hook_settings.rs", import.meta.url), "utf8");
const broker = readFileSync(new URL("../src-tauri/src/desktop_pet_e_agent.rs", import.meta.url), "utf8");

test("Grok keeps the existing synthetic PermissionRequest admission", () => {
  assert.match(hookSettings, /"Bash\|Edit\|Write\|MultiEdit"/);
  assert.match(hookSettings, /build_command\(exe, source, "PermissionRequest"\)/);
  assert.match(hookServer, /"grok" => matches!/);
  assert.match(hookServer, /"PreToolUse"/);
  assert.match(hookServer, /"PermissionRequest"/);
});

test("bypassPermissions suppresses only Grok approval prompts", () => {
  assert.match(hookClient, /Some\("bypassPermissions"\)/);
  assert.match(hookClient, /hook_input\.get\("permissionMode"\)/);
  assert.match(hookClient, /"grok" =>/);
  assert.match(hookClient, /event != "PermissionRequest"/);
});

test("unverified Grok interaction degrades to terminal jump", () => {
  assert.match(broker, /"desktopPetE\.agent\.grokJumpOnly"/);
  assert.match(broker, /has_known_tool_name/);
  assert.match(broker, /interactive_supported: false/);
  assert.doesNotMatch(broker, /request\.source == "grok"[\s\S]{0,240}interactive_supported: true/);
  assert.match(hookClient, /if source == "grok"/);
  assert.match(hookClient, /try_notify_input\(source, event, hook_input\)/);
  assert.match(hookClient, /keep_jump_only/);
  assert.match(hookServer, /jump_only_decision/);
  assert.match(hookServer, /"notification-only"/);
});

test("Grok install still enforces cross-vendor isolation", () => {
  assert.match(hookSettings, /disable_grok_cross_vendor_hooks/);
  assert.match(hookSettings, /verify_grok_cross_vendor_isolation/);
  assert.match(hookSettings, /compat\.claude/);
  assert.match(hookSettings, /compat\.cursor/);
});
