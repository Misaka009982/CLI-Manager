import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { folderTreeSortEvents } from "../src/features/files/lib/folderTreeSortEvents.ts";
import { evaluateExpression, findNode, readSource, sourceAst, variableExpression } from "./helpers/folderTreeSortFixture.mjs";

const menuPath = "src/features/files/components/FileTreeSortMenu.tsx";
const sidebarPath = "src/features/files/api/FileExplorerSidebar.tsx";

/** 隔离真实保存回调；焦点及 Portal 冒泡由独立 browser 脚本验证。 */
function saveFixture() {
  const updates = [], errors = [], closes = [];
  const mountedRef = { current: true }, savingRef = { current: false };
  const saveSort = evaluateExpression(variableExpression(menuPath, "saveSort", "FileTreeSortMenu"), {
    disabled: false, savingRef, mountedRef,
    setSaving: value => updates.push(value), changeOpen: value => closes.push(value),
    t: key => key, toast: { error: (...args) => errors.push(args) },
  });
  return { saveSort, mountedRef, savingRef, updates, errors, closes };
}

test("菜单只隔离传播，不破坏默认聚焦、键盘激活；拖放在箭头上被安全忽略", () => {
  for (const [name, handler] of Object.entries(folderTreeSortEvents)) {
    let stops = 0, prevents = 0;
    handler({ stopPropagation: () => stops++, preventDefault: () => prevents++ });
    assert.equal(stops, 1, name);
    assert.equal(prevents, name === "onDrop" || name === "onDragOver" ? 1 : 0, name);
  }
  for (const name of ["onPointerDown", "onClick", "onDoubleClick", "onContextMenu", "onKeyDown", "onDragStart", "onDrop"]) {
    assert.equal(typeof folderTreeSortEvents[name], "function", name);
  }
});

test("保存中不重复提交，成功关闭；失败保留菜单并允许重试", async () => {
  const fixture = saveFixture();
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const first = fixture.saveSort(async () => { calls++; await gate; });
  await fixture.saveSort(async () => { calls++; });
  assert.equal(calls, 1);
  assert.deepEqual(fixture.updates, [true]);
  release();
  await first;
  assert.deepEqual(fixture.closes, [false]);
  await fixture.saveSort(async () => { throw new Error("write_failed"); });
  assert.equal(fixture.errors.length, 1);
  assert.equal(fixture.errors[0][0], "files.sort.saveFailed");
  assert.equal(fixture.closes.length, 1);
  assert.equal(fixture.savingRef.current, false);
  await fixture.saveSort(async () => { calls++; });
  assert.deepEqual(fixture.closes, [false, false]);
});

test("切换作用域卸载旧菜单后，迟到回执不改新 UI 或弹出旧错误", async () => {
  for (const fail of [false, true]) {
    const fixture = saveFixture();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = fixture.saveSort(async () => { await gate; if (fail) throw new Error("late_failure"); });
    fixture.mountedRef.current = false;
    release();
    await pending;
    assert.deepEqual(fixture.updates, [true]);
    assert.deepEqual(fixture.closes, []);
    assert.deepEqual(fixture.errors, []);
  }
});

test("保存期间关闭仍重置末级目标，重新打开被禁止", () => {
  const opens = [], targets = [];
  const savingRef = { current: false };
  const changeOpen = evaluateExpression(variableExpression(menuPath, "changeOpen", "FileTreeSortMenu"), {
    disabled: false, savingRef, setOpen: value => opens.push(value),
    folder: { paths: ["a", "a/b", "a/b/c"], onPathChange: path => targets.push(path) },
  });
  changeOpen(true);
  savingRef.current = true;
  changeOpen(false);
  changeOpen(true);
  assert.deepEqual(opens, [true, false]);
  assert.deepEqual(targets, ["a/b/c", "a/b/c"]);
});

test("菜单上下键循环，Home/End 跳转，其他键保留默认行为", () => {
  const document = { activeElement: null };
  const items = [0, 1, 2].map(index => ({ index, focus() { document.activeElement = this; } }));
  const handler = evaluateExpression(variableExpression(menuPath, "handleMenuKeyDown", "FileTreeSortMenu"), { document });
  const event = key => ({ key, currentTarget: { querySelectorAll: selector => {
    assert.ok(selector.includes(":not(:disabled)")); return items;
  } }, prevents: 0, stops: 0, preventDefault() { this.prevents++; }, stopPropagation() { this.stops++; } });
  for (const [key, index] of [["ArrowDown", 0], ["ArrowUp", 2], ["Home", 0], ["End", 2]]) {
    const current = event(key); handler(current);
    assert.equal(document.activeElement, items[index]);
    assert.equal(current.prevents, 1); assert.equal(current.stops, 1);
  }
  for (const key of ["Escape", "Enter", " ", "Delete"]) {
    const current = event(key); handler(current);
    assert.equal(current.prevents, 0); assert.equal(current.stops, 0);
  }
});

test("真实文件行的激活区域和排序按钮并列，紧凑链及 SSH 只读仍有排序入口", () => {
  const ast = sourceAst(sidebarPath);
  const fileNode = findNode(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === "FileNode", "FileNode");
  const action = findNode(fileNode, node => ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attribute =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === "role" && attribute.initializer?.getText(ast) === '"button"'), "行激活区域");
  assert.doesNotMatch(action.getText(ast), /FolderTreeSortMenu/);
  assert.match(fileNode.getText(ast), /isDir && <FolderTreeSortMenu project=\{project\} paths=\{chainPaths\}/);
  assert.match(action.getText(ast), /ui-file-tree-row-action/);
  const wrapper = readSource("src/features/files/components/FolderTreeSortMenu.tsx");
  assert.match(wrapper, /key=\{JSON.stringify\(\[scope.key, paths\]\)\}/);
  assert.match(wrapper, /paths\[paths.length - 1\]/);
  assert.doesNotMatch(wrapper, /environment_type === "ssh"|readOnly/);
  assert.match(wrapper, /updateFolderTreeSort\(scope, targetPath, null\)/);
});

test("目录目标、来源和恢复文案覆盖中英文，顶部菜单保留全局入口", () => {
  for (const language of ["zh-CN", "en-US"]) {
    const messages = readSource(`src/shared/i18n/messages/files.${language}.ts`);
    for (const key of ["folder", "target", "independent", "inheritedFrom", "globalDefault", "inherit"]) {
      assert.ok(messages.includes(`"files.sort.${key}"`), `${language}: ${key}`);
    }
  }
  assert.match(readSource(sidebarPath), /onChange=\{updateFileTreeSort\}/);
  assert.match(readSource(menuPath), /contentRef.current\?\.querySelector/);
});
