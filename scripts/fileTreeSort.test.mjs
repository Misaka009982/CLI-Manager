import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_FILE_TREE_SORT,
  applyFileTreeSortChange,
  createFileTreeSortUpdater,
  migrateFileTreeSortSettings,
  sortFileTreeEntries,
} from "../src/shared/lib/fileTreeSort.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const entry = (name, kind, modifiedMs = null, children) => ({
  name,
  path: name,
  kind,
  sizeBytes: 0,
  modifiedMs,
  children,
});

test("name ascending keeps directories first and sorts numerically", () => {
  const sorted = sortFileTreeEntries(
    [
      entry("zeta.ts", "file"),
      entry("src", "directory"),
      entry("file10.ts", "file"),
      entry("File2.ts", "file"),
      entry("apps", "directory"),
    ],
    { key: "name", direction: "ascending" },
  );

  assert.deepEqual(sorted.map((item) => item.name), [
    "apps", "src", "File2.ts", "file10.ts", "zeta.ts",
  ]);
});

test("name descending reverses files but keeps directories first", () => {
  const sorted = sortFileTreeEntries(
    [entry("alpha.ts", "file"), entry("src", "directory"), entry("beta.ts", "file")],
    { key: "name", direction: "descending" },
  );

  assert.deepEqual(sorted.map((item) => item.name), ["src", "beta.ts", "alpha.ts"]);
});

test("date ascending lists oldest first and directories stay on top", () => {
  const sorted = sortFileTreeEntries(
    [
      entry("newest.ts", "file", 3000),
      entry("oldest.ts", "file", 1000),
      entry("middle.ts", "file", 2000),
      entry("dir", "directory", 9000),
    ],
    { key: "date", direction: "ascending" },
  );

  assert.deepEqual(sorted.map((item) => item.name), ["dir", "oldest.ts", "middle.ts", "newest.ts"]);
});

test("date descending puts the most recently changed file first", () => {
  const sorted = sortFileTreeEntries(
    [entry("old.ts", "file", 1000), entry("fresh.ts", "file", 5000), entry("mid.ts", "file", 3000)],
    { key: "date", direction: "descending" },
  );

  assert.deepEqual(sorted.map((item) => item.name), ["fresh.ts", "mid.ts", "old.ts"]);
});

test("未知及异常修改时间在两个方向都排在同类末尾，时间 0 仍然有效", () => {
  const source = [
    entry("null.ts", "file", null),
    entry("nan.ts", "file", Number.NaN),
    entry("infinity.ts", "file", Number.POSITIVE_INFINITY),
    entry("negative-infinity.ts", "file", Number.NEGATIVE_INFINITY),
    entry("negative.ts", "file", -1),
    { ...entry("missing.ts", "file"), modifiedMs: undefined },
    entry("known.ts", "file", 1000),
    entry("epoch.ts", "file", 0),
  ];

  for (const direction of ["ascending", "descending"]) {
    const sorted = sortFileTreeEntries(source, { key: "date", direction });
    assert.equal(sorted.length, source.length);
    assert.deepEqual(sorted.slice(0, 2).map((item) => item.name), direction === "ascending"
      ? ["epoch.ts", "known.ts"]
      : ["known.ts", "epoch.ts"]);
  }
});

test("sorting recurses into loaded child directories", () => {
  const sorted = sortFileTreeEntries(
    [
      entry("pkg", "directory", null, [
        entry("b.ts", "file", 2000),
        entry("nested", "directory", null, [
          entry("z.ts", "file", 100),
          entry("a.ts", "file", 300),
        ]),
        entry("a.ts", "file", 1000),
      ]),
    ],
    { key: "date", direction: "descending" },
  );

  assert.deepEqual(sorted[0].children.map((item) => item.name), ["nested", "b.ts", "a.ts"]);
  assert.deepEqual(sorted[0].children[0].children.map((item) => item.name), ["a.ts", "z.ts"]);
});

test("sorting never mutates the source array or unloaded subtrees keep identity", () => {
  const leaf = entry("kept", "directory");
  const source = [entry("b.ts", "file", 2), leaf, entry("a.ts", "file", 1)];

  const sorted = sortFileTreeEntries(source, { key: "name", direction: "ascending" });

  assert.deepEqual(source.map((item) => item.name), ["b.ts", "kept", "a.ts"]);
  assert.deepEqual(sorted.map((item) => item.name), ["kept", "a.ts", "b.ts"]);
  assert.equal(sorted[0], leaf);
});

test("corrupt or missing preferences fall back to the default", () => {
  assert.deepEqual(migrateFileTreeSortSettings(undefined), { ...DEFAULT_FILE_TREE_SORT });
  assert.deepEqual(migrateFileTreeSortSettings("nonsense"), { ...DEFAULT_FILE_TREE_SORT });
  assert.deepEqual(migrateFileTreeSortSettings({ key: "size", direction: "sideways" }), {
    ...DEFAULT_FILE_TREE_SORT,
  });
  assert.deepEqual(migrateFileTreeSortSettings({ key: "date", direction: "descending" }), {
    key: "date",
    direction: "descending",
  });
});

test("日期相同或都未知时按名称稳定排序，目录始终优先", () => {
  for (const direction of ["ascending", "descending"]) {
    for (const time of [5000, null]) {
      const source = [
        entry("z.ts", "file", time), entry("z-dir", "directory", time),
        entry("file10.ts", "file", time), entry("File2.ts", "file", time),
        entry("a-dir", "directory", time),
      ];
      assert.deepEqual(sortFileTreeEntries(source, { key: "date", direction }).map((item) => item.name),
        ["a-dir", "z-dir", "File2.ts", "file10.ts", "z.ts"]);
    }
  }
});

test("空树与冻结的深层源数据不被排序修改", () => {
  const children = Object.freeze([entry("z.ts", "file", 1), entry("a.ts", "file", 2)]);
  const directory = Object.freeze(entry("src", "directory", null, children));
  const source = Object.freeze([directory]);
  const sorted = sortFileTreeEntries(source, DEFAULT_FILE_TREE_SORT);

  assert.deepEqual(sortFileTreeEntries([], DEFAULT_FILE_TREE_SORT), []);
  assert.deepEqual(sorted[0].children.map((item) => item.name), ["a.ts", "z.ts"]);
  assert.deepEqual(children.map((item) => item.name), ["z.ts", "a.ts"]);
  assert.equal(source[0], directory);
  assert.notEqual(sorted[0].children, children);
});

test("切换日期默认最新在前，重复选择维度保留用户方向", () => {
  assert.deepEqual(applyFileTreeSortChange(DEFAULT_FILE_TREE_SORT, { key: "date" }), {
    key: "date", direction: "descending",
  });
  assert.deepEqual(applyFileTreeSortChange({ key: "date", direction: "ascending" }, { key: "date" }), {
    key: "date", direction: "ascending",
  });
  assert.deepEqual(applyFileTreeSortChange({ key: "date", direction: "descending" }, { key: "name" }), {
    key: "name", direction: "ascending",
  });
  assert.deepEqual(applyFileTreeSortChange({ key: "date", direction: "descending" }, { direction: "ascending" }), {
    key: "date", direction: "ascending",
  });
  assert.deepEqual(migrateFileTreeSortSettings({ key: "date" }), { key: "date", direction: "descending" });
  for (const invalid of [null, [], 3, {}]) {
    assert.deepEqual(migrateFileTreeSortSettings(invalid), DEFAULT_FILE_TREE_SORT);
  }
});

test("连续变更串行保存，后一次在执行时读取最新维度", async () => {
  let stored = { ...DEFAULT_FILE_TREE_SORT };
  let releaseFirst;
  const pendingFirst = new Promise((resolve) => { releaseFirst = resolve; });
  const writes = [];
  const update = createFileTreeSortUpdater(() => stored, async (next) => {
    writes.push({ ...next });
    if (writes.length === 1) await pendingFirst;
    stored = next;
  });

  const first = update({ key: "date" });
  const second = update({ direction: "ascending" });
  await Promise.resolve();
  assert.equal(writes.length, 1);
  assert.deepEqual(stored, DEFAULT_FILE_TREE_SORT);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(writes, [
    { key: "date", direction: "descending" },
    { key: "date", direction: "ascending" },
  ]);
  assert.deepEqual(stored, { key: "date", direction: "ascending" });
});

test("保存失败传播给调用者，保留原设置且不阻塞后续重试", async () => {
  let stored = { ...DEFAULT_FILE_TREE_SORT };
  let attempts = 0;
  const update = createFileTreeSortUpdater(() => stored, async (next) => {
    attempts += 1;
    if (attempts === 1) throw new Error("write_failed");
    stored = next;
  });

  await assert.rejects(update({ key: "date" }), /write_failed/);
  assert.deepEqual(stored, DEFAULT_FILE_TREE_SORT);
  await update({ key: "date" });
  assert.equal(attempts, 2);
  assert.deepEqual(stored, { key: "date", direction: "descending" });
});

test("the file explorer renders the persisted tree sort and exposes a sort control", () => {
  const sidebar = read("../src/features/files/api/FileExplorerSidebar.tsx");
  const menu = read("../src/features/files/components/FileTreeSortMenu.tsx");
  const settings = read("../src/shared/preferences/settingsStore.ts");
  const sync = read("../src/features/sync/lib/syncSettings.ts");
  const preference = read("../src/shared/preferences/fileTreeSortPreference.ts");

  assert.match(sidebar, /sortFileTreeEntries\(tree, fileTreeSort\)/);
  assert.match(sidebar, /useSettingsStore\(\(s\) => s\.fileTreeSort\)/);
  assert.match(sidebar, /onChange=\{updateFileTreeSort\}/);
  assert.match(sidebar, /hasSearchQuery && searchMode === "files" \? searchResults : sortedTree/);
  assert.match(preference, /createFileTreeSortUpdater\(/);
  assert.match(preference, /useSettingsStore\.getState\(\)\.fileTreeSort/);
  assert.match(preference, /update\("fileTreeSort", next\)/);
  assert.match(sidebar, /<FileTreeSortMenu/);
  assert.match(menu, /role="menuitemradio"/);
  assert.match(menu, /await onChange\(change\)/);
  assert.match(menu, /files\.sort\.saveFailed/);
  assert.match(menu, /aria-busy=\{saving\}/);
  assert.match(menu, /settings\.direction === "descending" \? <ArrowDown/);
  assert.match(settings, /fileTreeSort: FileTreeSortSettings/);
  assert.match(settings, /entries\.fileTreeSort = migrateFileTreeSortSettings\(entries\.fileTreeSort\)/);
  assert.match(settings, /key === "fileTreeSort" \? migrateFileTreeSortSettings\(value\)/);
  assert.match(sync, /fileTreeSort: "preferences"/);
});

test("both locales define every file tree sort key", () => {
  const zh = read("../src/shared/i18n/messages/files.zh-CN.ts");
  const en = read("../src/shared/i18n/messages/files.en-US.ts");
  for (const key of [
    "files.sort.label",
    "files.sort.byName",
    "files.sort.byDate",
    "files.sort.direction",
    "files.sort.oldestFirst",
    "files.sort.newestFirst",
    "files.sort.saving",
    "files.sort.saveFailed",
    "files.sort.ascending",
    "files.sort.descending",
  ]) {
    assert.ok(zh.includes(`"${key}"`), `zh-CN missing ${key}`);
    assert.ok(en.includes(`"${key}"`), `en-US missing ${key}`);
  }
});
