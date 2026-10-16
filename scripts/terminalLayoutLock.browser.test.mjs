import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, preview, normalizePath } from "vite";
import react from "@vitejs/plugin-react";

const fixture = resolve("scripts/fixtures");
const playwrightPath = process.env.SETTINGS_TEST_PLAYWRIGHT ?? join(homedir(),
  ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");

// 保留真实标签、DnD、Radix 菜单与主题 CSS，只隔离桌面状态和无关悬浮信息。
function isolatedTerminal() {
  const modules = new Map();
  const virtual = (name, code) => { const id = `\0terminal-lock:${name}`; modules.set(id, code); return id; };
  return {
    name: "isolated-terminal-layout-lock", enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source.startsWith(".")) return;
      const path = resolve(dirname(importer), source).toLowerCase();
      if ([resolve("src/shared/preferences/settingsStore"), join(fixture, "terminalLayoutLockStore")]
        .some(value => path === value.toLowerCase())) return normalizePath(join(fixture, "terminalLayoutLockStore.ts"));
      if (path.endsWith("/terminaltabsmodel") || path.endsWith("\\terminaltabsmodel")) return virtual("model", `
        export const TAB_NOTIFICATION_LABELS = { none: 'terminal.tab.closeCurrent' };
        export const SSH_CONNECTION_STATE_COLORS = {};
        export const TERMINAL_TAB_HOVER_DELAY_MS = 300, TERMINAL_TAB_HOVER_CLOSE_DELAY_MS = 100;
        export const TERMINAL_TAB_HOVER_CARD_WIDTH = 200, TERMINAL_TAB_HOVER_CARD_ESTIMATED_HEIGHT = 100;
        export const clampNumber = (n, a, b) => Math.min(b, Math.max(a, n));`);
      if (source.endsWith("/TerminalTabHoverCard")) return virtual("hover", "export const TerminalTabHoverCard = () => null;");
      if (source.endsWith("/VendorIcon")) return virtual("vendor", "export const VendorIcon = () => null;");
      if (source.endsWith("/CliToolIcon")) return virtual("cli", "export const CliToolIcon = () => null;");
    },
    load(id) { return modules.get(id); },
  };
}

test("terminal layout lock preserves menus and terminal-themed controls", { timeout: 180000 }, async t => {
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const output = await mkdtemp(join(tmpdir(), "cli-terminal-lock-"));
  let server; let browser;
  t.after(async () => {
    await browser?.close();
    await new Promise(done => server ? server.httpServer.close(done) : done());
    await rm(output, { recursive: true, force: true });
  });
  await build({ configFile: false, plugins: [isolatedTerminal(), react()], logLevel: "error",
    build: { outDir: output, emptyOutDir: false, rollupOptions: { input: join(fixture, "terminalLayoutLock.html") } } });
  server = await preview({ configFile: false, build: { outDir: output },
    preview: { host: "127.0.0.1", port: 0, strictPort: false }, logLevel: "error" });
  browser = await chromium.launch({ channel: process.env.SETTINGS_TEST_BROWSER ?? "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const url = `${server.resolvedUrls.local[0]}scripts/fixtures/terminalLayoutLock.html`;

  await t.test("both tab menus retain all actions before and after locking", async () => {
    for (const language of ["zh-CN", "en-US"]) {
      await page.goto(`${url}?language=${language}`);
      const lockText = language === "zh-CN" ? "锁定终端布局" : "Lock terminal layout";
      const unlockText = language === "zh-CN" ? "解锁终端布局" : "Unlock terminal layout";
      for (const locked of [false, true]) {
        if (locked) {
          await page.locator('[data-workspan-id="workspan-tab"]').click({ button: "right" });
          await page.getByRole("menuitem", { name: lockText, exact: true }).click();
          await page.getByRole("menu").waitFor({ state: "hidden" });
        }
        for (const selector of ['[data-terminal-tab-id="pane-tab"]', '[data-workspan-id="workspan-tab"]']) {
          await page.locator(selector).click({ button: "right" });
          const items = page.getByRole("menuitem");
          assert.deepEqual(await items.allTextContents(), ["Close", "Rename", "Split", locked ? unlockText : lockText]);
          assert.equal(await items.last().locator("svg").count(), 0);
          await page.keyboard.press("Escape");
        }
        await page.locator("#pane-bar .space").click({ button: "right" });
        assert.deepEqual(await page.getByRole("menuitem").allTextContents(), [locked ? unlockText : lockText]);
        assert.equal(await page.getByRole("menuitem").locator("svg").count(), 0);
        await page.keyboard.press("Escape");
      }
    }
  });

  await t.test("lock uses the same terminal theme as adjacent tab controls", async () => {
    for (const app of ["light", "dark"]) for (const terminal of ["light", "dark"]) {
      await page.goto(`${url}?app=${app}&terminal=${terminal}`);
      await page.locator("#toggle-lock").click();
      const styles = await page.locator("#pane-bar").evaluate(bar => {
        const read = selector => {
          const style = getComputedStyle(bar.querySelector(selector));
          return [style.color, style.backgroundColor, style.borderColor];
        };
        return { lock: read("[data-terminal-layout-lock]"), reference: read("[data-reference-button]") };
      });
      assert.deepEqual(styles.lock, styles.reference, `${app} app / ${terminal} terminal`);
      const tab = page.locator('[data-terminal-tab-id="pane-tab"]');
      const box = await tab.boundingBox();
      await page.mouse.move(box.x + 40, box.y + 10);
      await page.mouse.down();
      await page.mouse.move(box.x + 55, box.y + 10);
      await page.mouse.up();
      await page.locator("[data-sonner-toast]").waitFor();
      const toastStyles = await page.evaluate(() => {
        const toast = document.querySelector("[data-sonner-toast]").style;
        const action = document.querySelector("[data-sonner-toast] button[data-button]").style;
        return [toast.background, toast.color, toast.borderColor, action.background, action.color];
      });
      assert.deepEqual(toastStyles, ["", "", "", "", ""], "toast keeps default notification styling");
    }
  });
  assert.deepEqual(errors, []);
});
