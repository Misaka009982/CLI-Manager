import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { folderTreeSortBrowserPlugin } from "./helpers/folderTreeSortBrowserFixture.mjs";

// 仅复用已有浏览器工具和 Edge；脚本不安装依赖、不下载浏览器、不构建应用。
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE
  ?? ".codex/tools/browser-test/node_modules/playwright/index.mjs")).href);
const outDir = mkdtempSync(join(tmpdir(), "cli-folder-sort-browser-"));
let server, browser;
try {
  await build({ entryPoints: ["scripts/fixtures/folderTreeSort.tsx"], bundle: true,
    outfile: join(outDir, "fixture.js"), platform: "browser", format: "esm", jsx: "automatic",
    target: "es2022", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty" }, plugins: [folderTreeSortBrowserPlugin(resolve("."))] });
  const styles = readdirSync(resolve("dist/assets")).filter(name => /^(?:index|App)-.*\.css$/.test(name));
  assert.ok(styles.length, "需要用户已有的 dist/assets 应用样式；本脚本不代为构建");
  const builtStyles = styles.map(name => readFileSync(resolve("dist/assets", name), "utf8")).join("\n");
  assert.ok(builtStyles.includes(".ui-folder-sort-trigger") && builtStyles.includes(".ui-file-tree-row-action"),
    "应用样式尚未包含本轮文件夹排序；请由用户自行构建匹配当前源码的 dist");
  server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/fixture.js" ? "text/javascript" : "text/html; charset=utf-8");
    response.end(request.url === "/fixture.js" ? readFileSync(join(outDir, "fixture.js"))
      : '<!doctype html><html data-theme="dark"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.js"></script></html>');
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, hasTouch: true });
  const errors = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(error); });
  page.on("console", event => { if (event.type() === "error") console.error(event.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded" });
  for (const style of styles) await page.addStyleTag({ path: resolve("dist/assets", style) });
  await page.waitForFunction(() => Boolean(window.folderSortFixture));
  const snapshot = () => page.evaluate(() => window.folderSortFixture.snapshot());
  const row = (host, path) => page.locator(`#${host} .ui-file-tree-row[data-file-tree-path="${path}"]`).first();
  const trigger = (host, path) => row(host, path).locator(':scope > [data-folder-sort-control] button[aria-haspopup="menu"]');
  const openMenu = async (host, path) => {
    await trigger(host, path).click();
    const menu = page.locator(`#${host}-menus [role="menu"]`);
    await menu.waitFor();
    return menu;
  };
  const select = async (host, path, label) => {
    const menu = await openMenu(host, path);
    await menu.getByRole("menuitemradio", { name: label, exact: true }).click();
    await menu.waitFor({ state: "hidden" });
  };
  const children = (host, path) => row(host, path).locator("..").locator(".ui-file-tree-row").evaluateAll((elements, parent) =>
    elements.map(element => element.dataset.fileTreePath).filter(item => item.startsWith(parent + "/")
      && item.split("/").length === parent.split("/").length + 1), path);
  const initial = await snapshot();
  for (const host of ["sidebar", "panel"]) {
    assert.equal(await row(host, "root.txt").locator(".ui-folder-sort-trigger").count(), 0);
    assert.equal(await row(host, "logs").locator('[role="button"] .ui-folder-sort-trigger').count(), 0);
    assert.equal(await trigger(host, "logs").count(), 1);
  }

  // 实际行、Portal 菜单与共用更新器组合：一个面板设置，另一个同步。
  await select("sidebar", "logs", "按修改日期");
  assert.deepEqual(await children("sidebar", "logs"), ["logs/archive", "logs/z-new.txt", "logs/a-old.txt"]);
  assert.deepEqual(await children("panel", "src"), ["src/a.txt", "src/z.txt"]);
  assert.equal(await trigger("panel", "logs").getAttribute("data-sort-direction"), "descending");
  assert.deepEqual((await snapshot()).selected, initial.selected);
  assert.deepEqual((await snapshot()).expanded, initial.expanded);

  // 紧凑链中间层设置与恢复，不能删除更深层的独立规则。
  let menu = await openMenu("sidebar", "a/b/c");
  assert.equal(await menu.getByRole("menuitemradio", { name: "a/b/c", exact: true }).getAttribute("aria-checked"), "true");
  await menu.getByRole("menuitemradio", { name: "a/b", exact: true }).click();
  await menu.getByRole("menuitemradio", { name: "按修改日期", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
  menu = await openMenu("panel", "a/b/c");
  assert.ok(await menu.getByText("继承自：a/b", { exact: true }).isVisible());
  await menu.getByRole("menuitemradio", { name: "按名称", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
  menu = await openMenu("sidebar", "a/b/c");
  await menu.getByRole("menuitemradio", { name: "a/b", exact: true }).click();
  await menu.getByRole("menuitem", { name: "恢复继承", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
  const rules = (await snapshot()).overrides[initial.scope.key];
  assert.equal(Object.hasOwn(rules, "a/b"), false);
  assert.deepEqual(rules["a/b/c"], { key: "name", direction: "ascending" });
  menu = await openMenu("sidebar", "a/b/c");
  await page.evaluate(() => window.folderSortFixture.chain());
  await trigger("sidebar", "a/b/d").waitFor();
  await menu.waitFor({ state: "hidden" });
  assert.ok(Object.hasOwn((await snapshot()).overrides[initial.scope.key], "a/b/c"));
  await page.evaluate(() => window.folderSortFixture.chain(true));
  await trigger("sidebar", "a/b/c").waitFor();
  await page.locator('#sidebar header button[aria-haspopup="menu"]').click();
  menu = page.locator('#sidebar-menus [role="menu"]');
  await menu.getByRole("menuitemradio", { name: "按修改日期", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
  assert.deepEqual((await snapshot()).global, { key: "date", direction: "descending" });
  assert.equal(await trigger("sidebar", "a/b/c").getAttribute("data-sort-direction"), "ascending");

  // 键盘、右键、双击、触摸和拖放均不能冒泡成文件操作。
  await trigger("sidebar", "logs").focus();
  await page.keyboard.press("Enter");
  menu = page.locator('#sidebar-menus [role="menu"]');
  await menu.waitFor();
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "恢复继承");
  await page.keyboard.press("Home");
  assert.match(await page.evaluate(() => document.activeElement?.textContent), /按名称/);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  for (const key of ["Delete", "F2", "Control+c", "Control+x", "Control+v"]) await page.keyboard.press(key);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.ok(await trigger("sidebar", "logs").evaluate(element => element === document.activeElement));
  for (const event of ["dblclick", "contextmenu", "dragstart"]) await trigger("sidebar", "logs").dispatchEvent(event);
  const dropped = await trigger("sidebar", "logs").evaluate(element => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("application/x-cli-manager-file-entry", "fixture");
    return ["dragover", "drop"].map(type => element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer })));
  });
  assert.deepEqual(dropped, [false, false]);
  const pointerTarget = locator => locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return window.folderSortFixture.pointerTarget(rect.left + rect.width / 2, rect.top + rect.height / 2);
  });
  assert.equal(await pointerTarget(trigger("sidebar", "logs")), null, "指针捕获不会落入排序箭头");
  assert.equal(await pointerTarget(row("sidebar", "logs").locator(".ui-file-tree-row-action").first()), "logs", "正常目录仍是指针落点");
  await trigger("sidebar", "logs").tap();
  menu = page.locator('#sidebar-menus [role="menu"]');
  await menu.waitFor();
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.deepEqual((await snapshot()).calls, initial.calls);
  assert.equal(await page.getByText("ROOT_CONTEXT", { exact: true }).count(), 0);

  // KV 失败时旧值仍被选中，菜单可重试，不把失败宣称为成功。
  await page.evaluate(() => window.folderSortFixture.failNext());
  menu = await openMenu("sidebar", "logs");
  await menu.getByRole("menuitemradio", { name: "升序（最旧在前）", exact: true }).click();
  await page.getByText("排序偏好保存失败，请重试。", { exact: true }).waitFor();
  assert.ok(await menu.isVisible());
  assert.equal(await menu.getByRole("menuitemradio", { name: "降序（最新在前）", exact: true }).getAttribute("aria-checked"), "true");
  await menu.getByRole("menuitemradio", { name: "升序（最旧在前）", exact: true }).click();
  await menu.waitFor({ state: "hidden" });

  // 慢写入时禁用选项；Esc 可回到箭头，切换 Worktree 后迟到保存只写旧作用域。
  await page.evaluate(() => window.folderSortFixture.pause());
  menu = await openMenu("sidebar", "logs");
  await menu.getByRole("menuitemradio", { name: "按名称", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#sidebar-menus [role="menu"]')?.getAttribute("aria-busy") === "true");
  assert.equal(await menu.locator('[role^="menuitem"]:not(:disabled)').count(), 0);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.ok(await trigger("sidebar", "logs").evaluate(element => element === document.activeElement));
  await trigger("sidebar", "logs").click();
  assert.equal(await menu.count(), 0);
  await page.evaluate(() => window.folderSortFixture.root("C:/worktree"));
  await page.evaluate(() => window.folderSortFixture.release());
  await page.waitForFunction(key => window.folderSortFixture.snapshot().overrides[key]?.logs.key === "name", initial.scope.key);
  const switched = await snapshot();
  assert.notEqual(switched.scope.key, initial.scope.key);
  assert.equal(switched.overrides[switched.scope.key], undefined);
  assert.equal(await trigger("sidebar", "logs").getAttribute("data-sort-overridden"), null);
  await page.evaluate(() => window.folderSortFixture.reload());
  assert.deepEqual((await snapshot()).overrides, switched.overrides);

  // SSH 只读树仍能写入本地显示偏好；中英文和窄面板布局使用真实样式。
  await page.evaluate(() => window.folderSortFixture.ssh());
  await select("panel", "logs", "按修改日期");
  assert.equal((await snapshot()).scope.ignoreCase, false);
  await page.evaluate(() => window.folderSortFixture.language());
  menu = await openMenu("panel", "a/b/c");
  assert.ok(await menu.getByText("Target folder", { exact: true }).isVisible());
  assert.ok(await menu.getByText("Inherited global default", { exact: true }).isVisible());
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.folderSortFixture.theme());
  await page.setViewportSize({ width: 390, height: 844 });
  for (const host of ["sidebar", "panel"]) {
    const layout = await row(host, "very-long-folder-name-for-narrow-layout").evaluate(element => {
      const arrow = element.querySelector(".ui-folder-sort-trigger").getBoundingClientRect();
      const badge = element.querySelector(".ui-file-tree-status-badge").getBoundingClientRect();
      const label = element.querySelector(".ui-file-tree-row-action .truncate").getBoundingClientRect();
      const row = element.getBoundingClientRect();
      return { arrowLeft: arrow.left, arrowRight: arrow.right, badgeRight: badge.right,
        labelWidth: label.width, labelRight: label.right, badgeLeft: badge.left, rowRight: row.right };
    });
    assert.ok(layout.labelWidth > 0 && layout.labelRight <= layout.badgeLeft + 1);
    assert.ok(layout.badgeRight <= layout.arrowLeft + 1 && layout.arrowRight <= layout.rowRight + 1);
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []);
  console.log("PASS: 真实文件行/Portal/队列、侧栏及面板、紧凑链恢复、键盘焦点、事件隔离、失败重试、迟到保存、SSH、中英文和窄面板");
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
  rmSync(outDir, { recursive: true, force: true });
}
