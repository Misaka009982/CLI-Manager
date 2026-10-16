import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, preview, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';

const fixture = resolve('scripts/fixtures');
const modalPath = resolve('src/features/settings/api/SettingsModal.tsx');
const playwrightPath = process.env.SETTINGS_TEST_PLAYWRIGHT ?? join(homedir(),
  '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');

// 只替换业务页及桌面服务；设置外壳、布局、焦点陷阱、i18n 和 Mantine 均执行生产代码。
function isolatedSettings() {
  const modules = new Map();
  const virtual = (name, code) => { const id = `\0settings-escape:${name}`; modules.set(id, code); return id; };
  return {
    name: 'isolated-settings-escape',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return;
      const path = resolve(dirname(importer), source);
      if (resolve(importer).toLowerCase() === resolve('src/features/extensions/components/McpEditorDialog.tsx').toLowerCase()
        && source === '../api') return virtual('mcp-editor-api', `
          export const validateExtensionMcpResource = async () => {
            if (window.mcpTestDelay) await new Promise(resolve => window.mcpTestResume = resolve);
            return { valid: true, issues: [] };
          };
          export const upsertManagedMcpResource = async resource => {
            window.mcpTestSaved = resource;
            if (window.mcpTestFail) throw new Error('fixture save failure');
            return { ...resource, redactedFields: [] };
          };`);
      // Windows 路径和 Vite 模块 ID 必须统一，否则夹具与生产 i18n 会加载两份 store。
      if ([resolve('src/shared/preferences/settingsStore'), join(fixture, 'settingsEscapeStore')]
        .some(storePath => path.toLowerCase() === storePath.toLowerCase())) {
        return normalizePath(join(fixture, 'settingsEscapeStore.ts'));
      }
      if (resolve(importer).toLowerCase() !== modalPath.toLowerCase()) return;
      const page = source.match(/\/pages\/(\w+)$/)?.[1];
      if (page === 'CcConnectSettingsPage') return normalizePath(join(fixture, 'settingsEscapePage.tsx'));
      const empty = page ?? ({ '../index': 'HookSettingsPage', '../../extensions': 'GlobalExtensionsPage' })[source];
      if (empty) return virtual(empty, `export function ${empty}() { return null; }`);
      if (source.endsWith('/mcpSaving')) return virtual('mcp',
        'const requestLeave = callback => callback(); export const useMcpSaveWorkflow = () => ({ requestLeave, dialog: null });');
      if (source.endsWith('/WorkspaceBackground')) return virtual('background',
        'export const useWorkspaceBackground = () => ({ active: false });');
      if (source.endsWith('/systemFonts')) return virtual('font',
        'export const normalizeFontFamilyStack = font => font;');
      if (source.endsWith('/MantineThemeProvider')) return virtual('theme',
        `import { createElement } from 'react'; import { MantineProvider } from '@mantine/core';
         export const AppMantineThemeProvider = ({ children }) => createElement(MantineProvider,
           { forceColorScheme: new URLSearchParams(location.search).get('theme') ?? 'light' }, children);`);
    },
    load(id) { return modules.get(id); },
    transform(code, id) {
      if (normalizePath(id) === normalizePath(resolve('src/features/extensions/components/McpEditorDialog.tsx'))) {
        return code.replace('<Editor height=', '<Editor onMount={editor => { window.mcpTestEditor = editor; }} height=');
      }
    },
  };
}

test('settings Escape ownership and shell focus outlines in Chromium', { timeout: 300000 }, async t => {
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const output = await mkdtemp(join(tmpdir(), 'cli-settings-escape-'));
  let server; let browser;
  t.after(async () => {
    await browser?.close();
    await new Promise(done => server ? server.httpServer.close(done) : done());
    await rm(output, { recursive: true, force: true });
  });
  await build({ configFile: false, plugins: [isolatedSettings(), react()], logLevel: 'error',
    build: { outDir: output, emptyOutDir: false, minify: false, rollupOptions: { input: join(fixture, 'settingsEscape.html') } } });
  server = await preview({ configFile: false, build: { outDir: output },
    preview: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
  browser = await chromium.launch({ channel: process.env.SETTINGS_TEST_BROWSER ?? 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const url = `${server.resolvedUrls.local[0]}scripts/fixtures/settingsEscape.html`;
  const settings = page.locator('.ui-workspace-settings-dialog');
  const openSettings = async () => { await page.locator('#open-settings').click(); await settings.waitFor(); };

  await t.test('Escape does not draw an empty workspace outline; Tab still marks buttons', async () => {
    await page.goto(url);
    const main = page.locator('#main-content');
    await main.click({ position: { x: 500, y: 500 } });
    await page.keyboard.press('Escape');
    assert.equal(await main.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    assert.equal(await main.evaluate(el => document.activeElement === el), true, 'skip-link focus target remains focusable');
    await page.locator('#open-settings').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#keyboard-button').evaluate(el => el.matches(':focus-visible')), true);
    assert.notEqual(await page.locator('#keyboard-button').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
  });

  await t.test('hidden keepMounted drawers do not block closing, across language and theme', async () => {
    for (const theme of ['light', 'dark']) for (const language of ['zh-CN', 'en-US']) {
      await page.goto(`${url}?theme=${theme}`);
      await page.evaluate(language => window.escapeTest.language(language), language);
      await openSettings();
      assert.equal(await page.locator('[role="dialog"]').count(), 3, 'both closed drawers stay mounted');
      assert.equal(await settings.getAttribute('aria-label'), language === 'zh-CN' ? '设置窗口' : 'Settings');
      await settings.click({ position: { x: 600, y: 700 } });
      await page.keyboard.press('Escape');
      await settings.waitFor({ state: 'detached', timeout: 2000 });
    }
  });

  await t.test('visible drawer/modal owns one Escape, including zero-duration synchronous close', async () => {
    for (const duration of [200, 0]) for (const layer of ['web-device', 'cc-connect', 'inner-modal']) {
      await page.goto(`${url}?duration=${duration}`);
      await openSettings();
      await page.locator(`#open-${layer}`).click();
      const child = page.locator('[role="dialog"]').filter({ has: page.locator('input[aria-label]') }).filter({ visible: true });
      await child.waitFor();
      await child.locator('input').focus();
      await page.keyboard.press('Escape');
      await child.waitFor({ state: 'hidden' });
      assert.equal(await settings.isVisible(), true, 'child Escape must not also close settings');
      // Mantine 延迟归还焦点；下一次独立按键从设置控件发出，而非退出动画中的旧输入框。
      await page.waitForFunction(() => document.querySelector('.ui-workspace-settings-dialog')?.contains(document.activeElement));
      await page.keyboard.press('Escape');
      await settings.waitFor({ state: 'detached', timeout: 2000 });
    }
  });

  await t.test('consumed Escape and IME composition keep settings open without a shell outline', async () => {
    await page.goto(url);
    await openSettings();
    await page.locator('#consuming-input').focus();
    await page.keyboard.press('Escape');
    assert.equal(await settings.isVisible(), true);
    await settings.evaluate(el => {
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }));
    });
    assert.equal(await settings.isVisible(), true);
    assert.equal(await settings.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
  });

  await t.test('visible alertdialog blocks settings; a hidden ancestor or visibility releases it', async () => {
    for (const hiding of ['display', 'visibility']) {
      await page.goto(url);
      await openSettings();
      await page.evaluate(() => {
        const host = document.createElement('div');
        host.id = 'alert-host';
        host.innerHTML = '<div role="alertdialog">Confirmation</div>';
        document.body.append(host);
      });
      await settings.focus();
      await page.keyboard.press('Escape');
      assert.equal(await settings.isVisible(), true);
      await page.evaluate(hiding => {
        const host = document.getElementById('alert-host');
        if (hiding === 'display') host.style.display = 'none';
        else host.style.visibility = 'hidden';
      }, hiding);
      await page.keyboard.press('Escape');
      await settings.waitFor({ state: 'detached', timeout: 2000 });
    }
  });
  await t.test('MCP template menu, dirty confirmation and editor each own one Escape', async () => {
    for (const duration of [200, 0]) {
      await page.goto(`${url}?duration=${duration}`);
      await page.evaluate(() => window.escapeTest.language('en-US'));
      await openSettings(); await page.locator('#open-mcp').click();
      const editor = page.getByRole('dialog', { name: 'Add MCP resource' });
      await editor.waitFor();
      const template = editor.getByLabel('Configuration template');
      const templateBounds = await template.boundingBox();
      const viewBounds = await editor.locator('.mcp-editor-view').boundingBox();
      assert.ok(templateBounds.width <= 240 && templateBounds.x > viewBounds.x + viewBounds.width);
      assert.ok(Math.abs(templateBounds.y + templateBounds.height - viewBounds.y - viewBounds.height) < 3);
      await template.click();
      await page.getByRole('option', { name: 'Baizhi', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('option', { name: 'Baizhi', exact: true }).isVisible(), false);
      assert.equal(await editor.isVisible(), true);
      await template.click(); await page.getByRole('option', { name: 'Baizhi', exact: true }).click();
      assert.equal(await editor.getByRole('button', { name: 'Undo template change' }).count(), 0);
      await editor.locator('[data-mcp-field="name"]').focus();
      await page.keyboard.press('Escape');
      const confirmation = page.getByRole('dialog', { name: 'Discard unsaved MCP changes?' });
      await confirmation.waitFor();
      assert.equal(await editor.isVisible(), true); assert.equal(await settings.isVisible(), true);
      await page.keyboard.press('Escape'); await confirmation.waitFor({ state: 'hidden' });
      assert.equal(await editor.isVisible(), true);
      await editor.locator('[data-mcp-field="name"]').focus(); await page.keyboard.press('Escape');
      await confirmation.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await editor.waitFor({ state: 'detached' });
      assert.equal(await settings.isVisible(), true);
      await page.waitForFunction(() => document.activeElement?.id === 'open-mcp');
      // 按住 Esc 的 repeat 不应在子窗卸载后关闭设置。
      await page.locator('#open-mcp').dispatchEvent('keydown', { key: 'Escape', repeat: true, bubbles: true });
      assert.equal(await settings.isVisible(), true);
      await page.keyboard.press('Escape'); await settings.waitFor({ state: 'detached' });
    }
  });
  await t.test('MCP added rows focus silently; suggestions require interaction in both themes and languages', async () => {
    for (const [theme, language, width] of [['light', 'en-US', 1200], ['dark', 'zh-CN', 520]]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${url}?theme=${theme}`);
      await page.evaluate(language => window.escapeTest.language(language), language);
      await openSettings(); await page.locator('#open-mcp').click();
      const editor = page.locator('.mcp-editor');
      const env = editor.locator('.mcp-field-group').nth(1);
      await env.locator('button[data-add]').click();
      const key = env.getByRole('combobox').first();
      await page.waitForFunction(() => document.activeElement?.hasAttribute('data-row-id'));
      assert.equal(await key.evaluate(el => el === document.activeElement), true);
      assert.equal(await key.getAttribute('aria-expanded'), 'false', 'programmatic focus must not open suggestions');
      await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      assert.equal(await key.getAttribute('aria-expanded'), 'false', 'Tab focus must not open suggestions');
      await key.click();
      await page.getByRole('option', { name: 'GITHUB_TOKEN', exact: true }).scrollIntoViewIfNeeded();
      await page.getByRole('option', { name: 'GITHUB_TOKEN', exact: true }).click();
      assert.equal(await key.inputValue(), 'GITHUB_TOKEN');
      await env.locator('button[data-add]').click();
      const second = env.getByRole('combobox').nth(1);
      await second.focus();
      assert.equal(await second.getAttribute('aria-expanded'), 'false');
      await second.fill('au');
      await page.getByRole('option', { name: 'Authorization', exact: true }).click();
      assert.equal(await second.inputValue(), 'Authorization');
      await second.fill('proxy');
      await page.getByRole('option', { name: 'ALL_PROXY', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await second.press('ArrowDown');
      await page.getByRole('option', { name: 'HTTP_PROXY', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await env.locator('.mcp-row-remove').nth(1).click();
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-row-id') !== null
        && document.activeElement?.getAttribute('role') === 'combobox');
      assert.equal(await key.getAttribute('aria-expanded'), 'false', 'delete-neighbor focus must not reopen suggestions');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await editor.locator('.mcp-editor-scroll').evaluate(el => { el.scrollTop = 0; });
      if (process.env.SETTINGS_TEST_SCREENSHOTS) {
        await mkdir(process.env.SETTINGS_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: join(process.env.SETTINGS_TEST_SCREENSHOTS, `mcp-form-${theme}.png`) });
      }
    }
  });
  await t.test('MCP suggestions, focus, small viewport, IME and save locking', async () => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(`${url}?theme=dark`);
    await page.evaluate(() => window.escapeTest.language('en-US'));
    await openSettings(); await page.locator('#open-mcp').click();
    const editor = page.getByRole('dialog', { name: 'Add MCP resource' });
    await editor.getByLabel('Configuration template').click();
    await page.getByRole('option', { name: 'Baizhi', exact: true }).click();
    const header = editor.getByRole('combobox', { name: 'Headers name 1' });
    await header.fill('au'); await page.keyboard.press('ArrowDown');
    const suggestion = page.getByRole('option', { name: 'Authorization', exact: true });
    await suggestion.waitFor();
    assert.equal(await suggestion.evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }), true, 'portal option must be clickable above editor');
    await page.keyboard.press('Enter'); assert.equal(await header.inputValue(), 'Authorization');
    await header.fill('au'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
    assert.equal(await editor.isVisible(), true);
    assert.equal(await page.getByRole('dialog', { name: 'Discard unsaved MCP changes?' }).isVisible(), false);
    await header.dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true });
    assert.equal(await editor.isVisible(), true);
    await header.fill('Authorization');
    await editor.getByRole('textbox', { name: 'Value 1' }).fill('Bearer example-only');
    const save = editor.getByRole('button', { name: 'Save resource', exact: true });
    await save.focus(); await page.keyboard.press('Tab');
    assert.equal(await editor.evaluate(el => el.contains(document.activeElement)), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => { window.mcpTestDelay = true; });
    await save.click(); await page.waitForFunction(() => !!window.mcpTestResume);
    await editor.dispatchEvent('keydown', { key: 'Escape', bubbles: true });
    assert.equal(await editor.isVisible(), true); assert.equal(await settings.isVisible(), true);
    await page.evaluate(() => window.mcpTestResume());
    await editor.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.mcpTestSaved.enabledByCli.claude), false);
  });
  await t.test('real Monaco retains invalid JSON, duplicate keys, template state and save failures', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(url);
    await page.evaluate(() => window.escapeTest.language('en-US'));
    await openSettings(); await page.locator('#open-mcp').click();
    const editor = page.getByRole('dialog', { name: 'Add MCP resource' });
    // 新建时无需先填临时名称即可进入 JSON 粘贴，未编辑也能回到空白表单。
    await editor.getByText('JSON', { exact: true }).click();
    await page.waitForFunction(() => !!window.mcpTestEditor?.getModel());
    await editor.getByText('Form', { exact: true }).click();
    assert.equal(await editor.locator('[data-mcp-field="name"]').inputValue(), '');
    await editor.getByLabel('Configuration template').click();
    await page.getByRole('option', { name: 'Composio', exact: true }).click();
    await editor.getByText('JSON', { exact: true }).click();
    await page.waitForFunction(() => !!window.mcpTestEditor?.getModel());
    await page.evaluate(() => window.mcpTestEditor.getModel().setValue('{bad'));
    await editor.getByLabel('Configuration template').click();
    await page.getByRole('option', { name: 'Baizhi', exact: true }).click();
    assert.equal(await editor.getByLabel('Configuration template').inputValue(), 'Composio');
    assert.equal(await page.evaluate(() => window.mcpTestEditor.getModel().getValue()), '{bad');
    await page.evaluate(() => window.mcpTestEditor.getModel().setValue('{"mcpServers":{"test":{"command":"x","command":"y"}}}'));
    await editor.getByText('Form', { exact: true }).click();
    assert.equal(await editor.locator('.monaco-editor').isVisible(), true);
    await page.evaluate(() => window.mcpTestEditor.getModel().setValue('{"mcpServers":{"custom":{"command":"tool","args":[""],"vendor":{"flag":true}}}}'));
    await editor.getByText('Form', { exact: true }).click();
    assert.equal(await editor.locator('[data-mcp-field="name"]').inputValue(), 'custom');
    await page.evaluate(() => { window.mcpTestFail = true; });
    await editor.getByRole('button', { name: 'Save resource', exact: true }).click();
    await editor.getByRole('alert').waitFor();
    assert.equal(await editor.locator('[data-mcp-field="name"]').inputValue(), 'custom');
    await page.evaluate(() => { window.mcpTestFail = false; });
    await editor.getByRole('button', { name: 'Save resource', exact: true }).click();
    await editor.waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.mcpTestSaved.args), ['']);
    assert.deepEqual(await page.evaluate(() => window.mcpTestSaved.perCliExtensions.claude), { vendor: { flag: true } });
    assert.equal(await settings.isVisible(), true);
  });
  assert.deepEqual(errors, []);
});
