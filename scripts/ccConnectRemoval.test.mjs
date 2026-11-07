import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// 编译实际模块，仅隔离桌面磁盘和无关工作区依赖，不连接用户当前运行实例。
function load(path, dependencies = {}) {
  const source = read(path);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: path,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports,
    require: (name) => name in dependencies ? dependencies[name] : require(name),
  }, { filename: path });
  return module.exports;
}

const migration = load("src/features/terminal/lib/retiredSessionMigration.ts");

function sessionFixture({ failSave = false, backup = [] } = {}) {
  const regular = { id: "normal", title: "normal", startupCmd: "codex" };
  const retired = { id: "old", title: "old", remoteHandoff: { phase: "active", cliSessionId: "thread" } };
  const data = new Map([["sessions", [regular, retired]], ["retiredRemoteHandoffSessions", backup]]);
  const operations = [];
  const store = {
    get: async (key) => data.get(key),
    set: async (key, value) => { operations.push(key); data.set(key, value); },
    save: async () => { operations.push("save"); if (failSave) throw new Error("disk failure"); },
  };
  const module = load("src/features/terminal/api/sessionStore.ts", {
    "@tauri-apps/plugin-store": { Store: { load: async () => store } },
    "../../../shared/platform/appPaths": { getCliManagerDataPaths: async () => ({ sessionsStorePath: "isolated" }) },
    "../../../shared/lib/singleFlight": { singleFlight: (fn) => fn },
    "../lib/retiredSessionMigration": migration,
    "../../../shared/i18n/index": { translateCurrent: (key) => key },
    "sonner": { toast: { warning: () => operations.push("notice") } },
    "./terminalWorkspan": { migrateTerminalWorkspans: (value) => value ?? [], sanitizeTerminalWorkspans: (value) => value },
  });
  return { state: module.useSessionStore, data, operations, regular, retired };
}

test("the actual remote page exposes both existing Web sections without cc-connect", () => {
  const server = () => null;
  const devices = () => null;
  const page = load("src/features/settings/components/pages/RemoteConnectionsSettingsPage.tsx", {
    "@mantine/core": { Stack: "stack" },
    "../WebServerSettingsSection": { WebServerSettingsSection: server },
    "../WebDeviceSettingsSection": { WebDeviceSettingsSection: devices },
  }).RemoteConnectionsSettingsPage();
  assert.equal(page.type, "stack");
  assert.equal(page.props.children.length, 2);
  assert.equal(page.props.children[0].type, server);
  assert.equal(page.props.children[1].type, devices);
});

test("ordinary local, WSL, SSH and split session objects are unchanged", () => {
  const sessions = [{ id: "local" }, { id: "wsl", environmentType: "wsl" },
    { id: "ssh", environmentType: "ssh" }, { id: "pane", projectId: "project" }];
  const result = migration.partitionRetiredSessions(sessions);
  assert.equal(result.retired.length, 0);
  assert.equal(result.sessions.length, sessions.length);
  result.sessions.forEach((session, index) => assert.equal(session, sessions[index]));
});

test("legacy handoffs of every phase are quarantined, never silently restarted", () => {
  const sessions = ["pending", "active", "cancelling", "recovery_failed"]
    .map((phase) => ({ id: phase, remoteHandoff: { phase } }));
  const result = migration.partitionRetiredSessions(sessions);
  assert.equal(result.sessions.length, 0);
  assert.equal(result.retired.length, 4);
  result.retired.forEach((session, index) => assert.equal(session, sessions[index]));
});

test("restoring a mixed split drops the retired pane and resolves a valid active session", () => {
  const panes = load("src/features/terminal/api/terminalPaneTree.ts");
  const workspans = load("src/features/terminal/api/terminalWorkspan.ts", { "./terminalPaneTree": panes });
  const mixed = {
    ...workspans.createTerminalWorkspan("workspace", "old-pane", "retired"),
    paneTree: { id: "split", type: "split", direction: "horizontal", ratio: 0.5,
      first: panes.createPaneLeaf("old-pane", ["retired"], "retired"),
      second: panes.createPaneLeaf("live-pane", ["normal"], "normal") },
  };
  const restored = workspans.restoreTerminalWorkspans([mixed], { normal: "restored-normal" });
  const sanitized = workspans.sanitizeTerminalWorkspans(restored, new Set(["restored-normal"]));
  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].activeSessionId, "restored-normal");
  assert.equal(sanitized[0].paneTree.type, "leaf");
  assert.equal(sanitized[0].activePaneId, "live-pane");
});

test("actual Store load saves the complete backup before removing automatic restore entries", async () => {
  const existing = { id: "previous-backup" };
  const fixture = sessionFixture({ backup: [existing] });
  await fixture.state.getState().load();
  assert.deepEqual(fixture.operations, ["retiredRemoteHandoffSessions", "save", "sessions", "save", "notice"]);
  const backup = fixture.data.get("retiredRemoteHandoffSessions");
  assert.equal(backup[0], existing);
  assert.equal(backup[1], fixture.retired);
  assert.equal(fixture.state.getState().sessions[0], fixture.regular);
  assert.equal(fixture.state.getState().sessions.length, 1);
  await fixture.state.getState().load();
  assert.equal(fixture.data.get("retiredRemoteHandoffSessions").length, 2);
});

test("backup write failure never rewrites original sessions or opens the restore gate", async () => {
  const fixture = sessionFixture({ failSave: true });
  await assert.rejects(fixture.state.getState().load(), /disk failure/);
  assert.deepEqual(fixture.operations, ["retiredRemoteHandoffSessions", "save"]);
  assert.equal(fixture.data.get("sessions")[1], fixture.retired);
  assert.equal(fixture.state.getState().loaded, false);
});

test("a corrupt existing backup is not overwritten", async () => {
  const fixture = sessionFixture({ backup: { unknown: "preserve" } });
  await assert.rejects(fixture.state.getState().load(), /retired_session_backup_invalid/);
  assert.equal(fixture.operations.length, 0);
  assert.equal(fixture.state.getState().loaded, false);
});

test("retry after a partial disk commit does not duplicate or overwrite backups", () => {
  const first = { id: "old", remoteHandoff: { cliSessionId: "thread" } };
  const different = { ...first, title: "later metadata" };
  const result = migration.mergeRetiredSessionBackup([first], [{ ...first }, different]);
  assert.equal(result.length, 2);
  assert.equal(result[0], first);
  assert.equal(result[1], different);
});

test("dedicated modules, IPC, autostart and pet controls are absent", () => {
  for (const path of ["src-tauri/src/features/remote/cc_connect", "src/features/remote/api/remoteHandoff.ts",
    "src/features/remote/api/remoteHandoffStore.ts", "src/features/remote/api/useRemoteHandoffCoordinator.ts",
    "src/features/terminal/components/RemoteHandoffOverlay.tsx"]) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, path);
  }
  for (const path of ["src-tauri/src/lib.rs", "src-tauri/src/commands/mod.rs", "src/app/App.tsx",
    "src/features/desktop-pet/api/DesktopPetApp.tsx", "src/features/desktop-pet/api/useDesktopPetCoordinator.ts"]) {
    assert.doesNotMatch(read(path), /cc_connect|CcConnect|remoteHandoff|remote-handoff/);
  }
});

test("Tap uses the shared launcher and the existing Codex proxy", () => {
  const source = read("src-tauri/src/commands/web_conversation.rs");
  assert.match(source, /crate::agent_launcher::resolve_local_agent_program/);
  assert.match(source, /codex_app_server_proxy::HELPER_SUBCOMMAND/);
  assert.match(source, /codex_app_server_proxy::load_codex_profile_overrides/);
  assert.doesNotMatch(source, /cc_connect::/);
  const proxy = read("src-tauri/src/features/codex-proxy/mod.rs");
  assert.doesNotMatch(proxy, /cc-connect send|SshHandoffHookForwarder|inject_local_handoff_delivery_context/);
});

test("ordinary Hook dispatch and legacy socket migration protections remain wired", () => {
  const daemon = read("src-tauri/src/infrastructure/daemon/server.rs");
  assert.match(daemon, /dispatcher\.try_enqueue/);
  assert.match(daemon, /update_task_status_from_hook/);
  assert.match(daemon, /broadcast_hook/);
  assert.doesNotMatch(daemon, /RemoteHandoffNotifier/);
  assert.match(read("src-tauri/src/features/providers/commands.rs"), /legacy_remote_state::retained_provider_snapshot_id/);
  assert.match(read("src-tauri/src/infrastructure/storage/app_paths/runtime_socket.rs"), /api\.sock/);
});
