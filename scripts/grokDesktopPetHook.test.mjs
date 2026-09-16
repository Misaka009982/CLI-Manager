import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const hookClient = readFileSync(new URL("../src-tauri/src/features/hooks/client.rs", import.meta.url), "utf8");
const hookServer = readFileSync(new URL("../src-tauri/src/features/hooks/claude.rs", import.meta.url), "utf8");
const hookSettings = [
  "../src-tauri/src/features/hooks/settings/mod.rs",
  "../src-tauri/src/features/hooks/settings/grok.rs",
  "../src-tauri/src/features/hooks/settings/json_hooks.rs",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
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
  // rustfmt 把这段拆成了多行（`hook_input` 与 `.get(...)` 不再相邻），旧断言要求两者紧贴所以失效。
  assert.match(hookClient, /\.get\("permissionMode"\)\s*\.or_else\(\|\| hook_input\.get\("permission_mode"\)\)/);
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
