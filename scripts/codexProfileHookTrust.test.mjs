import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function source(file) { return readFileSync(new URL(`../${file}`, import.meta.url), "utf8"); }
function compile(file, bindings = {}, expose = []) {
  const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
  const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText()).join("\n");
  const exports = {};
  runInNewContext(ts.transpileModule(body + expose.map(name => `\nexports.${name} = ${name};`).join(""), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText, { exports, ...bindings });
  return exports;
}
const parser = compile("src/features/history/api/resumeCliArgs.ts");
const { codexHookNeedsReview, codexHookStatusErrorMessage } = compile("src/features/settings/api/codexHookStatus.ts");
const profileApi = compile("src/features/terminal/api/codexHookProfile.ts", {
  extractCodexProfileName: parser.extractCodexProfileName,
  useTerminalStore: selector => selector(globalThis.terminalState),
});

test("extracts actual profile through new/resume/fork, quotes, short and equal options", () => {
  for (const command of [
    'codex --no-daemon --profile managed', 'codex -p managed resume abc',
    'codex resume abc --profile=managed', 'codex -pmanaged', 'codex -p=managed',
    'codex --profile="managed"', 'codex fork abc -p managed',
    '& "C:\\Program Files\\codex.exe" --profile managed',
    'codex.ps1 --profile managed', 'codex -c "x=--profile fake" --profile managed',
  ]) assert.equal(parser.extractCodexProfileName(command), "managed", command);
  for (const command of [
    'claude --profile fake', 'echo codex --profile fake', 'codex -- --profile fake',
    'codex "--profile fake"', 'codex -c "--profile fake"',
    'codex --model --profile', 'codex ; codex --profile fake',
  ]) assert.equal(parser.extractCodexProfileName(command), null, command);
});

test("actual command wins over provider fallback and remote/transcript never borrow Windows profile", () => {
  const local = { id: "one", cliTool: "codex", startupCmd: "codex --profile project-combined",
    providerSnapshot: { codexProfileName: "supplier" } };
  assert.equal(profileApi.codexHookProfileForSession(local), "project-combined");
  assert.equal(profileApi.codexHookProfileForSession({ ...local, startupCmd: "codex" }), null);
  assert.equal(profileApi.codexHookProfileForSession({ ...local, startupCmd: undefined }), "supplier");
  for (const patch of [{ environmentType: "wsl" }, { environmentType: "ssh" }, { sshHostId: "ssh" },
    { kind: "subagent-transcript" }, { shell: "wsl" }, { wslDistroName: "Ubuntu" }, { remoteHandoff: {} }]) {
    assert.equal(profileApi.codexHookProfileForSession({ ...local, ...patch }), null);
  }
  globalThis.terminalState = { sessions: [local], activeSessionId: "one" };
  assert.equal(profileApi.useActiveCodexHookProfile(), "project-combined");
  globalThis.terminalState.activeSessionId = null;
  assert.equal(profileApi.useActiveCodexHookProfile(), null);
});

// Small React hook runner: persistent slots, dependency comparison and real effect cleanup.
function requestHarness() {
  const slots = [], effects = [], requests = [], timers = new Map(), listeners = new Map();
  let cursor = 0, output, context;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const memo = (fn, deps) => {
    const i = cursor++;
    if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { value: fn(), deps };
    return slots[i].value;
  };
  const eventTarget = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
  };
  const doc = { ...eventTarget, visibilityState: "visible" };
  const hook = compile("src/features/settings/api/useHookStatusRequest.ts", {
    codexHookNeedsReview, codexHookStatusErrorMessage, translateCurrent: key => key, Error,
    useRef: initial => { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
    useState: initial => { const i = cursor++; slots[i] ??= { value: initial }; return [slots[i].value, v => { slots[i].value = v; }]; },
    useCallback: (fn, deps) => memo(() => fn, deps),
    useEffect: (fn, deps) => {
      const i = cursor++, previous = slots[i];
      if (previous && same(previous.deps, deps)) return;
      slots[i] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); });
    },
    document: doc,
    window: { ...eventTarget, setInterval: (fn, ms) => { timers.set(fn, ms); return fn; }, clearInterval: fn => timers.delete(fn) },
    invoke: (command, args) => new Promise((resolve, reject) => requests.push({ command, args, resolve, reject })),
  }).useHookStatusRequest;
  return {
    requests, doc, timers, listeners,
    render(next = context) { context = next; cursor = 0; output = hook(context); while (effects.length) effects.shift()(); return output; },
    get output() { return output; },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
  };
}
const ready = { hooksTrusted: false, hooksFeatureInstalled: true, sessionStartHookInstalled: true,
  runningHookInstalled: true, attentionHookInstalled: true, stopHookInstalled: true, subagentStartHookInstalled: true };
const status = (trusted = true) => ({ codex: { ...ready, hooksTrusted: trusted } });

test("all commands carry same profile and stale status/mutation success cannot color a new tab", async () => {
  const h = requestHarness();
  h.render({ codexProfileName: "one" });
  const old = h.output.invokeStatus("hook_settings_install_codex");
  assert.equal(h.requests[0].args.codexProfileName, "one");
  h.render({ codexProfileName: "two" });
  assert.equal(h.output.status, null);
  const fresh = h.output.invokeStatus("hook_settings_get_status");
  h.requests[1].resolve(status(false)); await fresh;
  h.requests[0].resolve(status()); assert.equal(await old, null);
  assert.equal(h.render().status.codex.hooksTrusted, false);
  const mutation = h.output.invokeStatus("hook_settings_uninstall_pi", { module: "running" });
  assert.equal(h.requests[2].args.codexProfileName, "two");
  h.requests[2].resolve(status()); await mutation;
  assert.equal(h.render().status.codex.hooksTrusted, true);
  h.unmount();
});

test("latest response wins, stale errors are ignored, current error removes green, unmount invalidates", async () => {
  const h = requestHarness(); h.render({ codexProfileName: "one" });
  const first = h.output.invokeStatus("hook_settings_get_status");
  const second = h.output.invokeStatus("hook_settings_get_status");
  h.requests[1].resolve(status()); await second;
  h.requests[0].reject(new Error("old")); assert.equal(await first, null);
  assert.equal(h.render().status.codex.hooksTrusted, true);
  const failed = h.output.invokeStatus("hook_settings_get_status");
  h.requests[2].reject(new Error("broken profile")); await assert.rejects(failed, /broken profile/);
  assert.equal(h.render().status, null);
  const pending = h.output.invokeStatus("hook_settings_get_status");
  h.unmount(); h.requests[3].resolve(status()); assert.equal(await pending, null);
  assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
});

test("visible pending review refresh is read-only, avoids overlap, stops after trusted/hidden", async () => {
  const h = requestHarness(); h.render({ codexProfileName: "one" });
  const initial = h.output.invokeStatus("hook_settings_get_status");
  h.requests[0].resolve(status(false)); await initial; h.render();
  assert.deepEqual([...h.timers.values()], [10000]);
  const tick = [...h.timers.keys()][0]; tick();
  assert.equal(h.requests[1].args.autoRepair, false);
  tick(); assert.equal(h.requests.length, 2);
  h.requests[1].resolve(status()); await new Promise(resolve => setImmediate(resolve)); h.render();
  tick(); assert.equal(h.requests.length, 2);
  h.doc.visibilityState = "hidden"; h.listeners.get("focus")(); assert.equal(h.requests.length, 2);
  h.doc.visibilityState = "visible"; h.listeners.get("visibilitychange")(); assert.equal(h.requests.length, 3);
  h.requests[2].resolve(status()); h.unmount();
});

test("pending review requires installed definitions; both real UI entries use scoped request pipeline", () => {
  assert.equal(codexHookNeedsReview(ready), true);
  assert.equal(codexHookNeedsReview({ ...ready, attentionHookInstalled: false }), false);
  assert.equal(codexHookNeedsReview({ ...ready, hooksTrusted: true }), false);
  assert.equal(codexHookNeedsReview(undefined), false);
  for (const path of ["src/features/projects/components/SidebarFooter.tsx", "src/features/settings/components/HookSettingsPage.tsx"]) {
    const code = source(path);
    assert.match(code, /useActiveCodexHookProfile\(\)/);
    assert.match(code, /useHookStatusRequest\(/);
    assert.doesNotMatch(code, /invoke<HookSettingsStatus>/);
    assert.match(code, /invokeStatus\("hook_settings_get_status"/);
  }
  assert.doesNotMatch(source("src/features/projects/components/SidebarFooter.tsx"), /lightStatus === "installed" \|\| pendingReview/);
  assert.match(source("src/features/settings/components/HookSettingsPage.tsx"), /<CodexHookScopeStatus status=\{codex\}/);
  assert.match(source("src-tauri/src/features/providers/service/scope.rs"), /codex_profile::write_preserving_hook_state/);
  const backend = source("src-tauri/src/features/hooks/settings/mod.rs");
  assert.equal((backend.match(/codex_profile_name: Option<String>/g) ?? []).length, 11);
  assert.equal((backend.match(/build_codex_status_for_profile\([^;\n]+codex_profile_name.as_deref\(\)\)/g) ?? []).length, 11);
});


test("real sidebar pending click reinstalls hooks with actual profile context", async () => {
  const calls = [], opened = [], contexts = [];
  const missing = { configDir: null, status: "directoryMissing" };
  const value = { claude: missing, kimi: missing, pi: missing, grok: missing,
    codex: { ...ready, configDir: "home", status: "partialInstalled", effectiveConfigPath: "home/managed.config.toml" } };
  const settings = { codexHookBridgeEnabled: true, update: async () => {} };
  const ui = compile("src/features/projects/components/SidebarFooter.tsx", {
    React: { createElement: (type, props) => ({ type, props }) },
    useState: initial => [initial, () => {}], useMemo: fn => fn(), useCallback: fn => fn,
    useEffect: fn => fn(), useI18n: () => ({ t: key => key }),
    useSettingsStore: selector => selector(settings), useActiveCodexHookProfile: () => "managed",
    useHookStatusRequest: context => { contexts.push(context); return { status: value, invokeStatus: async (cmd, args) => { calls.push({ cmd, args }); return value; } }; },
    codexHookNeedsReview, toast: { success: () => {}, error: error => assert.fail(error) },
  }, ["HookStatusLight"]);
  const button = ui.HookStatusLight({ onOpenSettings: tab => opened.push(tab) });
  assert.equal(contexts[0].codexProfileName, "managed");
  assert.equal(button.props["data-hook-status"], "partial");
  assert.match(button.props.title, /managed.config.toml/);
  button.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, []);
  assert.deepEqual(calls.map(call => call.cmd), ["hook_settings_get_status",
    "hook_settings_uninstall_codex", "hook_settings_install_codex", "hook_settings_get_status"]);
  value.codex = { ...value.codex, status: "installed", hooksTrusted: true };
  calls.length = 0;
  ui.HookStatusLight({ onOpenSettings: tab => opened.push(tab) }).props.onClick();
  assert.deepEqual(opened, ["hooks"]);
  assert.deepEqual(calls.map(call => call.cmd), ["hook_settings_get_status"]);
});

test("old directory callback cannot initiate mutation after changing scope", async () => {
  const h = requestHarness();
  h.render({ codexProfileName: "one", codexSelectedDir: "old" });
  const oldInvoke = h.output.invokeStatus;
  const pending = oldInvoke("hook_settings_get_status");
  h.render({ codexProfileName: "one", codexSelectedDir: "new" });
  assert.equal(await oldInvoke("hook_settings_install_codex"), null);
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve(status()); assert.equal(await pending, null);
  assert.equal(h.render().status, null); h.unmount();
});

test("profile error labels are localized and preserve path details", () => {
  const zh = compile("src/shared/i18n/messages/settings.zh-CN.ts").zh;
  const en = compile("src/shared/i18n/messages/settings.en-US.ts").en;
  for (const dictionary of [zh, en]) {
    const result = codexHookStatusErrorMessage("codex_hook_profile_missing: home/test.config.toml", key => dictionary[key]);
    assert.ok(result.startsWith(dictionary["settings.hooks.codex.profileMissing"]));
    assert.match(result, /home\/test.config.toml/);
    for (const key of Object.keys(zh).filter(key => key.startsWith("settings.hooks.codex."))) assert.equal(typeof dictionary[key], "string");
  }
});
