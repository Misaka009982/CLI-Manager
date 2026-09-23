import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// 编译执行生产模块，只替换 Tauri/Store 等边界，不复制路由算法。
function loadModule(path, dependencies = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  runInNewContext(output, { module, exports: module.exports, require: (name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected import: ${name}`);
    return dependencies[name];
  } });
  return module.exports;
}

const programs = loadModule("src/shared/lib/externalTerminalProgram.ts");
const shell = loadModule("src/shared/platform/shell.ts", { "@tauri-apps/api/core": {} });
const sync = loadModule("src/features/sync/lib/syncSettings.ts");

function harness(settings, failure) {
  const calls = [], errors = [];
  const api = loadModule("src/features/terminal/api/externalTerminal.ts", {
    "@tauri-apps/api/core": { invoke: async (...args) => { calls.push(JSON.parse(JSON.stringify(args))); if (failure) throw failure; } },
    "sonner": { toast: { error: (...args) => errors.push(args) } },
    "../../../shared/platform/logger": { logError: () => {} },
    "../../../shared/preferences/settingsStore": { useSettingsStore: { getState: () => settings } },
    "../../../shared/lib/externalTerminalProgram": programs,
    "../../../shared/platform/shell": shell,
    "../../../shared/i18n/index": { translateCurrent: (key) => key },
  });
  return { ...api, calls, errors };
}

test("legacy/invalid preferences use WT and valid direct programs survive", () => {
  for (const value of [undefined, null, "", "anything.exe", {}, 7]) assert.equal(programs.normalizeExternalTerminalProgram(value), "windows-terminal");
  for (const value of programs.EXTERNAL_TERMINAL_PROGRAMS) assert.equal(programs.normalizeExternalTerminalProgram(value), value);
  assert.equal(sync.SETTING_BACKUP_POLICY.externalTerminalProgram, "excluded");
});

test("each program reaches IPC with WSL, native and custom shells intact", async () => {
  for (const program of programs.EXTERNAL_TERMINAL_PROGRAMS) {
    const h = harness({ externalTerminalProgram: program, defaultShell: "powershell.exe" });
    await h.openWindowsTerminal([
      { title: "WSL", shell: "wsl.exe", cwd: "\\\\wsl.localhost\\Ubuntu\\home\\project", startupCmd: "codex --yolo" },
      { title: "PS", shell: "powershell.exe" },
      { title: "Custom", shell: "C:\\custom path\\powershell.exe" },
    ]);
    assert.equal(h.calls[0][0], "open_windows_terminal");
    assert.equal(h.calls[0][1].program, program);
    assert.deepEqual(h.calls[0][1].tabs.map((tab) => tab.shell), ["wsl", "powershell", "C:\\custom path\\powershell.exe"]);
    assert.equal(h.calls[0][1].tabs[0].startup_cmd, "codex --yolo");
  }
});

test("context-free terminal respects selected direct program or default WT Shell", async () => {
  const h = harness({ externalTerminalProgram: "cmd", defaultShell: "pwsh" });
  await h.openWindowsTerminal([{ title: "Shell" }]);
  assert.equal(h.calls[0][1].tabs[0].shell, null);
  const wt = harness({ defaultShell: "powershell.exe" });
  await wt.openWindowsTerminal([{ title: "Shell" }]);
  assert.equal(wt.calls[0][1].tabs[0].shell, "powershell");
});

test("preference is read for each launch, and empty batch launches nothing", async () => {
  const settings = { externalTerminalProgram: "cmd", defaultShell: "pwsh" };
  const h = harness(settings);
  await h.openWindowsTerminal([]);
  assert.equal(h.calls.length, 0);
  await h.openWindowsTerminal([{ title: "first" }]);
  settings.externalTerminalProgram = "pwsh";
  await h.openWindowsTerminal([{ title: "second" }]);
  assert.deepEqual(h.calls.map((call) => call[1].program), ["cmd", "pwsh"]);
});

test("missing selected executable surfaces translated error without retry", async () => {
  const h = harness({ externalTerminalProgram: "pwsh" }, new Error("external_terminal_program_not_found: pwsh.exe"));
  await h.openWindowsTerminal([{ title: "Shell" }]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.errors[0][0], "settings.terminal.externalOpenFailed");
  assert.equal(h.errors[0][1].description, "settings.terminal.externalProgramMissing");
});

test("all new settings copy exists in both languages", () => {
  const zh = loadModule("src/shared/i18n/messages/settings.zh-CN.ts").zh;
  const en = loadModule("src/shared/i18n/messages/settings.en-US.ts").en;
  for (const key of ["externalProgram", "externalProgramDescription", "externalOpenFailed", "externalProgramMissing"]) {
    assert.ok(zh[`settings.terminal.${key}`]);
    assert.ok(en[`settings.terminal.${key}`]);
    assert.notEqual(zh[`settings.terminal.${key}`], en[`settings.terminal.${key}`]);
  }
});
