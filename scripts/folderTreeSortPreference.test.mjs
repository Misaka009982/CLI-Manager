import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FILE_TREE_SORT, migrateFileTreeSortSettings } from "../src/shared/lib/fileTreeSort.ts";
import * as overridesModule from "../src/shared/lib/fileTreeSortOverrides.ts";
import { pickSyncableSettings } from "../src/features/sync/lib/syncSettings.ts";
import {
  evaluateExpression, evaluatePreferenceModule, settingsDefaultsSource,
  settingsMigrationSource, settingsUpdateExpression, sourceFunction,
} from "./helpers/folderTreeSortFixture.mjs";

const fileOperationRootKey = sourceFunction("src/features/files/lib/fileExplorerOperations.ts", "fileOperationRootKey");
const fileContentRoot = sourceFunction("src/features/files/lib/fileContentResidency.ts", "fileContentRoot", { fileOperationRootKey });
const scopeOf = sourceFunction("src/features/files/lib/fileTreeSortScope.ts", "fileTreeSortScope", {
  fileContentRoot, parseFileTreeSortScope: overridesModule.parseFileTreeSortScope,
});
const project = (path, extra = {}) => ({ id: "project", path, environment_type: "local", ...extra });
const scope = scopeOf(project("C:/repo"));
const byDate = { key: "date", direction: "descending" };

/** 复用实际 load/update/偏好模块；只用内存 KV 替代 Tauri 持久化传输。 */
function settingsFixture(entries = {}) {
  const migrations = { migrateFileTreeSortSettings, migrateFileTreeSortOverrides: overridesModule.migrateFileTreeSortOverrides };
  const load = evaluateExpression(`entries => { ${settingsMigrationSource()} return entries; }`, migrations);
  const defaults = evaluateExpression(`({ ${settingsDefaultsSource()} })`, { DEFAULT_FILE_TREE_SORT });
  let state = { ...defaults, ...load({ ...entries }), loaded: true };
  let beforeWrite = async () => {};
  const disk = new Map();
  const writes = [];
  const update = evaluateExpression(settingsUpdateExpression(), {
    ...migrations, get: () => state, set: patch => { state = { ...state, ...patch }; },
    getStore: async () => ({ set: async (key, value) => {
      writes.push({ key, value });
      await beforeWrite(key, value);
      disk.set(key, JSON.parse(JSON.stringify(value)));
    } }),
    prepareDesktopPetSettingUpdate: () => assert.fail("本夹具只允许排序设置"),
    applyDebugMode: () => assert.fail("排序不应改变 debugMode"),
  });
  state.update = update;
  const context = { tauri: true, read: () => state, overridesModule };
  const preference = evaluatePreferenceModule(context);
  return {
    preference, context, writes, read: () => state, setState: patch => { state = { ...state, ...patch }; },
    beforeWrite: callback => { beforeWrite = callback; },
    disk: () => Object.fromEntries(disk),
    reload: snapshot => { state = { ...state, ...load({ ...snapshot }) }; },
  };
}

test("真实作用域同时区分项目、Worktree、Windows 与 Linux 路径身份", () => {
  assert.equal(scopeOf(null), null);
  assert.equal(scopeOf(project("", { id: "" })), null);
  assert.equal(scopeOf(project("")), null);
  assert.equal(scopeOf(project("C:\\Repo\\")).key, scopeOf(project("c:/repo")).key);
  assert.notEqual(scopeOf(project("C:/repo")).key, scopeOf(project("C:/repo-worktree")).key);
  assert.notEqual(scopeOf(project("C:/repo")).key, scopeOf(project("C:/repo", { id: "other" })).key);
  assert.equal(scopeOf(project("\\\\Server\\Share\\Repo\\")).ignoreCase, true);
  for (const path of ["//wsl.localhost/Ubuntu/home/Repo", "//wsl$/Ubuntu/home/Repo", "/home/Repo"]) {
    const env = { environment_type: "wsl" };
    assert.equal(scopeOf(project(path, env)).ignoreCase, false);
    assert.notEqual(scopeOf(project(path, env)).key, scopeOf(project(path.toLowerCase(), env)).key);
  }
  assert.equal(scopeOf(project("/", { environment_type: "wsl" })).key, JSON.stringify(["project", "wsl", "/"]));
});

test("SSH 主机和实际远程根隔离，远程大小写保留，缺失主机不能保存", () => {
  const remote = (host, root) => scopeOf(project("C:/placeholder", {
    environment_type: "ssh", ssh_host_id: host, remote_path: root,
  }));
  assert.equal(remote("host-a", "/home/Repo/").key, remote("host-a", "/home/Repo").key);
  assert.equal(remote("host-a", "/home/Repo").ignoreCase, false);
  assert.notEqual(remote("host-a", "/home/Repo").key, remote("host-b", "/home/Repo").key);
  assert.notEqual(remote("host-a", "/home/Repo").key, remote("host-a", "/home/repo").key);
  assert.notEqual(remote("host-a", "/home/Repo").key, remote("host-a", "/home/other").key);
  assert.equal(remote(null, "/home/Repo"), null);
});

test("旧配置加载为空覆盖；真实设置默认值、加载与备份恢复都使用校验", async () => {
  const fixture = settingsFixture({ fileTreeSort: byDate });
  assert.deepEqual(fixture.read().fileTreeSort, byDate);
  assert.deepEqual(fixture.read().fileTreeSortOverrides, {});
  await fixture.preference.updateFolderTreeSort(scope, "Src", { key: "name" });
  const backup = JSON.parse(JSON.stringify(pickSyncableSettings({ ...fixture.read(), debugMode: true })));
  assert.equal(Object.hasOwn(backup, "debugMode"), false);
  assert.deepEqual(backup.fileTreeSortOverrides[scope.key].src, DEFAULT_FILE_TREE_SORT);
  fixture.reload(fixture.disk());
  assert.deepEqual(fixture.read().fileTreeSortOverrides, backup.fileTreeSortOverrides);
  const imported = { ...backup, fileTreeSortOverrides: {
    ...backup.fileTreeSortOverrides,
    [scope.key]: { ...backup.fileTreeSortOverrides[scope.key], "../bad": byDate, broken: { key: "size" } },
    malformed: { src: byDate },
  } };
  for (const [key, value] of Object.entries(pickSyncableSettings(imported))) await fixture.read().update(key, value);
  assert.deepEqual(fixture.read().fileTreeSortOverrides, backup.fileTreeSortOverrides);
  assert.deepEqual(fixture.disk().fileTreeSortOverrides, backup.fileTreeSortOverrides);
  await fixture.read().update("fileTreeSortOverrides", []);
  assert.deepEqual(fixture.read().fileTreeSortOverrides, {});
});

test("真实偏好接线共用队列：慢全局保存后，目录更新读取新的继承值", async () => {
  const fixture = settingsFixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  fixture.beforeWrite(async key => { if (key === "fileTreeSort") await gate; });
  const first = fixture.preference.updateFileTreeSort({ key: "date" });
  const second = fixture.preference.updateFolderTreeSort(scope, "logs", { direction: "ascending" });
  const third = fixture.preference.updateFolderTreeSort(scope, "src", { key: "name" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fixture.writes.length, 1);
  assert.deepEqual(fixture.read().fileTreeSort, DEFAULT_FILE_TREE_SORT);
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(fixture.read().fileTreeSortOverrides[scope.key], {
    logs: { key: "date", direction: "ascending" }, src: DEFAULT_FILE_TREE_SORT,
  });
  assert.deepEqual(fixture.writes.map(write => write.key), ["fileTreeSort", "fileTreeSortOverrides", "fileTreeSortOverrides"]);
});

test("写盘失败前不发布新真值，错误传播且重试可用", async () => {
  const fixture = settingsFixture();
  const previous = fixture.read().fileTreeSortOverrides;
  fixture.beforeWrite(async () => { throw new Error("write_failed"); });
  await assert.rejects(fixture.preference.updateFolderTreeSort(scope, "src", { key: "date" }), /write_failed/);
  assert.equal(fixture.read().fileTreeSortOverrides, previous);
  assert.deepEqual(fixture.disk(), {});
  fixture.beforeWrite(async () => {});
  await fixture.preference.updateFolderTreeSort(scope, "src", { key: "date" });
  assert.deepEqual(fixture.read().fileTreeSortOverrides[scope.key].src, byDate);
});

test("非 Tauri、偏好未加载或非法目标均不能写盘，后续正常操作不被阻塞", async () => {
  const fixture = settingsFixture();
  fixture.context.tauri = false;
  await assert.rejects(fixture.preference.updateFolderTreeSort(scope, "src", { key: "date" }), /settings_unavailable/);
  fixture.context.tauri = true;
  fixture.setState({ loaded: false });
  await assert.rejects(fixture.preference.updateFileTreeSort({ key: "date" }), /settings_unavailable/);
  fixture.setState({ loaded: true });
  await assert.rejects(fixture.preference.updateFolderTreeSort(scope, "../bad", { key: "date" }), /invalid_file_tree_sort_target/);
  assert.equal(fixture.writes.length, 0);
  await fixture.preference.updateFolderTreeSort(scope, "src", { key: "name" });
  assert.equal(fixture.writes.length, 1);
});
