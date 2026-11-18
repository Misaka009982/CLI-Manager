import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FILE_TREE_SORT, sortFileTreeEntries } from "../src/shared/lib/fileTreeSort.ts";
import {
  createFileTreeSortPreferencesUpdater,
  migrateFileTreeSortOverrides,
  normalizeFileTreeSortPath,
  resolveFolderTreeSort,
} from "../src/shared/lib/fileTreeSortOverrides.ts";

const scope = { key: JSON.stringify(["project", "local", "c:/repo"]), ignoreCase: true };
const otherScope = { key: JSON.stringify(["project", "local", "c:/worktree"]), ignoreCase: true };
const byDate = { key: "date", direction: "descending" };
const byNameDescending = { key: "name", direction: "descending" };
const entry = (path, kind, modifiedMs = null, children) => ({
  path, name: path.split("/").at(-1), kind, modifiedMs, sizeBytes: 0, children,
});

function preferences(initial = {}) {
  let state = { fileTreeSort: { ...DEFAULT_FILE_TREE_SORT }, fileTreeSortOverrides: {}, ...initial };
  const writes = [];
  const updater = createFileTreeSortPreferencesUpdater(
    () => state,
    async (next) => { writes.push(["global", next]); state = { ...state, fileTreeSort: next }; },
    async (next) => { writes.push(["folders", next]); state = { ...state, fileTreeSortOverrides: next }; },
  );
  return { updater, writes, read: () => state };
}

test("父级只排序内部，最近覆盖优先，同级与相似前缀不受影响", () => {
  const rules = { logs: byDate, "logs/archive": byNameDescending };
  const children = [entry("logs/a.txt", "file", 1), entry("logs/z.txt", "file", 2),
    entry("logs/archive", "directory", 0, [entry("logs/archive/a", "file"), entry("logs/archive/z", "file")])];
  const source = Object.freeze([Object.freeze(entry("logs", "directory", 0, Object.freeze(children))),
    entry("src", "directory", 0, [entry("src/z", "file"), entry("src/a", "file")])]);
  const sorted = sortFileTreeEntries(source, DEFAULT_FILE_TREE_SORT,
    (path, inherited) => resolveFolderTreeSort(rules, path, inherited, false).settings);
  assert.deepEqual(sorted.map(item => item.name), ["logs", "src"]);
  assert.deepEqual(sorted[0].children.map(item => item.name), ["archive", "z.txt", "a.txt"]);
  assert.deepEqual(sorted[0].children[0].children.map(item => item.name), ["z", "a"]);
  assert.deepEqual(sorted[1].children.map(item => item.name), ["a", "z"]);
  assert.deepEqual(children.map(item => item.name), ["a.txt", "z.txt", "archive"]);
  assert.equal(resolveFolderTreeSort(rules, "logs2/archive", DEFAULT_FILE_TREE_SORT).sourcePath, null);
  assert.equal(resolveFolderTreeSort(rules, "logs/archive/deep", DEFAULT_FILE_TREE_SORT).sourcePath, "logs/archive");
  assert.deepEqual(sortFileTreeEntries([], DEFAULT_FILE_TREE_SORT), []);
});

test("继承同值选择建立独立规则；全局与父级更改不清理后代覆盖", async () => {
  const { updater, read } = preferences();
  await updater.updateFolder(scope, "src", { key: "name" });
  await updater.updateFolder(scope, "src/nested", { key: "date" });
  await updater.updateGlobal({ key: "date" });
  assert.deepEqual(read().fileTreeSortOverrides[scope.key].src, DEFAULT_FILE_TREE_SORT);
  await updater.updateFolder(scope, "src", { direction: "descending" });
  await updater.updateFolder(scope, "src", null);
  const rules = read().fileTreeSortOverrides[scope.key];
  assert.equal(Object.hasOwn(rules, "src"), false);
  assert.deepEqual(rules["src/nested"], byDate);
  assert.deepEqual(resolveFolderTreeSort(rules, "src", read().fileTreeSort).settings, byDate);
  await updater.updateFolder(scope, "src/nested", null);
  assert.equal(Object.hasOwn(read().fileTreeSortOverrides, scope.key), false);
});

test("同一与不同作用域连续更新按出队时真值合并", async () => {
  const { updater, read } = preferences();
  await Promise.all([
    updater.updateGlobal({ key: "date" }),
    updater.updateFolder(scope, "logs", { direction: "ascending" }),
    updater.updateFolder(scope, "logs", { key: "name" }),
    updater.updateFolder(scope, "other", { key: "date" }),
    updater.updateFolder(otherScope, "logs", { direction: "ascending" }),
  ]);
  assert.deepEqual(read().fileTreeSortOverrides[scope.key].logs, DEFAULT_FILE_TREE_SORT);
  assert.deepEqual(read().fileTreeSortOverrides[scope.key].other, byDate);
  assert.deepEqual(read().fileTreeSortOverrides[otherScope.key].logs, { key: "date", direction: "ascending" });
});

test("慢保存期间捕获目标，不丢更新；失败传播且后续操作继续", async () => {
  let state = { fileTreeSort: DEFAULT_FILE_TREE_SORT, fileTreeSortOverrides: {} };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let attempts = 0;
  const updater = createFileTreeSortPreferencesUpdater(() => state,
    async next => { state = { ...state, fileTreeSort: next }; },
    async next => {
      attempts++;
      if (attempts === 1) { await gate; throw new Error("write_failed"); }
      state = { ...state, fileTreeSortOverrides: next };
    });
  const capturedScope = { ...scope };
  const first = updater.updateFolder(capturedScope, "logs", { key: "date" });
  const second = updater.updateFolder(capturedScope, "src", { key: "name" });
  capturedScope.key = otherScope.key;
  await Promise.resolve();
  assert.equal(attempts, 1);
  release();
  await assert.rejects(first, /write_failed/);
  await second;
  assert.deepEqual(state.fileTreeSortOverrides[scope.key].src, DEFAULT_FILE_TREE_SORT);
  assert.equal(state.fileTreeSortOverrides[otherScope.key], undefined);
  await updater.updateFolder(scope, "logs", { key: "date" });
  assert.deepEqual(state.fileTreeSortOverrides[scope.key].logs, byDate);
});

test("畸形偏好被过滤，Windows 路径规范化与 POSIX 大小写保留", () => {
  for (const value of [null, [], 42, "invalid"]) assert.deepEqual(migrateFileTreeSortOverrides(value), {});
  const linuxKey = JSON.stringify(["project", "wsl", "//wsl.localhost/Ubuntu/home/Repo"]);
  const sshKey = JSON.stringify(["project", "ssh", JSON.stringify(["ssh", "host-a", "/home/Repo"])]);
  const input = {
    invalid: { src: byDate },
    [scope.key]: { "SRC\\Nested": byDate, "../bad": byDate, "/absolute": byDate, wrong: { key: "size" } },
    [linuxKey]: { Src: byDate, src: byNameDescending },
    [sshKey]: { Src: byDate, src: byNameDescending },
  };
  input[scope.key] = { ...input[scope.key], ...JSON.parse('{"__proto__":{"key":"name","direction":"ascending"}}') };
  const migrated = migrateFileTreeSortOverrides(input);
  assert.deepEqual(migrated[scope.key], { "src/nested": byDate });
  assert.deepEqual(migrated[linuxKey], { Src: byDate, src: byNameDescending });
  assert.deepEqual(migrated[sshKey], { Src: byDate, src: byNameDescending });
  assert.equal(Object.hasOwn(migrated, "invalid"), false);
  assert.equal(normalizeFileTreeSortPath("C:/outside", true), null);
  assert.equal(normalizeFileTreeSortPath("src/../other", false), null);
  assert.equal(normalizeFileTreeSortPath("src2", false), "src2");
  assert.equal(resolveFolderTreeSort(migrated[scope.key], "SRC/NESTED/deep", DEFAULT_FILE_TREE_SORT, true).sourcePath, "src/nested");
});

test("每个目录支持四种规则，未知时间后置且未加载节点保持引用", () => {
  const unloaded = entry("logs/unloaded", "directory");
  const children = Object.freeze([entry("logs/z", "file", 2), entry("logs/a", "file", 1),
    entry("logs/unknown", "file"), unloaded]);
  const source = Object.freeze([Object.freeze(entry("logs", "directory", 0, children))]);
  for (const [settings, expected] of [
    [{ key: "name", direction: "ascending" }, ["unloaded", "a", "unknown", "z"]],
    [{ key: "name", direction: "descending" }, ["unloaded", "z", "unknown", "a"]],
    [{ key: "date", direction: "ascending" }, ["unloaded", "a", "z", "unknown"]],
    [{ key: "date", direction: "descending" }, ["unloaded", "z", "a", "unknown"]],
  ]) {
    const sorted = sortFileTreeEntries(source, DEFAULT_FILE_TREE_SORT,
      (path, inherited) => resolveFolderTreeSort({ logs: settings }, path, inherited).settings);
    assert.deepEqual(sorted[0].children.map(item => item.name), expected);
    assert.equal(sorted[0].children[0], unloaded);
  }
  assert.deepEqual(children.map(item => item.name), ["z", "a", "unknown", "unloaded"]);
});

test("set/reset 交错按序执行，同值已有覆盖不重写，其他 scope 和后代保留", async () => {
  const { updater, read, writes } = preferences();
  await Promise.all([
    updater.updateFolder(scope, "src", { key: "name" }),
    updater.updateFolder(scope, "src/nested", { key: "date" }),
    updater.updateFolder(otherScope, "src", { key: "date" }),
    updater.updateFolder(scope, "src", null),
    updater.updateFolder(scope, "src", { key: "date" }),
  ]);
  assert.deepEqual(read().fileTreeSortOverrides[scope.key], { src: byDate, "src/nested": byDate });
  assert.deepEqual(read().fileTreeSortOverrides[otherScope.key], { src: byDate });
  const count = writes.length;
  await updater.updateFolder(scope, "src", { key: "date" });
  await updater.updateFolder(scope, "missing", null);
  assert.equal(writes.length, count);
});

test("非法目标不产生覆盖，POSIX 反斜杠文件名不误判为目录分隔", async () => {
  const { updater, writes } = preferences();
  for (const path of ["", "../outside", "src/../other", "/outside", "C:/outside", "src//nested", "constructor"]) {
    await assert.rejects(updater.updateFolder(scope, path, { key: "date" }), /invalid_file_tree_sort_target/);
  }
  await assert.rejects(updater.updateFolder({ key: "invalid", ignoreCase: true }, "src", { key: "date" }), /invalid_file_tree_sort_target/);
  assert.equal(writes.length, 0);
  assert.equal(normalizeFileTreeSortPath("src\\part", false), "src\\part");
  assert.equal(resolveFolderTreeSort({ src: byDate }, "src\\part", DEFAULT_FILE_TREE_SORT, false).sourcePath, null);
});
