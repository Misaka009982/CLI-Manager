import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/features/extensions/lib/importSources.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { suggestImportSources } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const home = { homePath: 'C:\\Users\\测试', targets: {
  claudeConfigDir: 'C:\\Users\\测试\\.claude', codexConfigDir: 'C:\\Users\\测试\\.codex', grokConfigDir: 'C:\\Users\\测试\\.grok',
} };

test('Hook paths take priority; provider Home remains a separate source', () => {
  assert.deepEqual(suggestImportSources('codex', 'nativeMcp', 'D:\\Custom Home\\codex\\', home), [
    { origin: 'hook', path: 'D:\\Custom Home\\codex\\config.toml' },
    { origin: 'home', path: 'C:\\Users\\测试\\.codex\\config.toml' },
  ]);
});
test('No Hook required, no cc-switch path guessing', () => {
  assert.equal(suggestImportSources('grok', 'skillDirectory', null, home)[0].path, 'C:\\Users\\测试\\.grok\\skills');
  assert.deepEqual(suggestImportSources('codex', 'ccswitch', 'D:\\codex', home), []);
  assert.deepEqual(suggestImportSources('codex', 'nativeMcp', null, null), []);
});
test('Claude default and explicit config layouts remain distinguishable and deduplicated', () => {
  assert.deepEqual(suggestImportSources('claude', 'nativeMcp', home.targets.claudeConfigDir, home).map(x => x.path), [
    'C:\\Users\\测试\\.claude.json', 'C:\\Users\\测试\\.claude\\.claude.json',
  ]);
  assert.equal(suggestImportSources('claude', 'nativeMcp', '/profiles/work', null)[0].path, '/profiles/work/.claude.json');
});
test('WSL UNC, POSIX and spaces preserve their source environment', () => {
  assert.equal(suggestImportSources('codex', 'skillDirectory', '\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex', null)[0].path,
    '\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex\\skills');
  assert.equal(suggestImportSources('grok', 'nativeMcp', '/Users/test user/.grok', null)[0].path, '/Users/test user/.grok/config.toml');
});
test('Inventory scroll boundary is outside the natural-height stack', () => {
  const ui = readFileSync(new URL('../src/features/extensions/components/SkillInventoryPanel.tsx', import.meta.url), 'utf8');
  assert.match(ui, /<div style=\{\{ maxHeight: 420, overflowY: "auto" \}\}>\s*<Stack gap="xs">/);
  assert.doesNotMatch(ui, /<Stack[^>]*mah=\{420\}/);
});
