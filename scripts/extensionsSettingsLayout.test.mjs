import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('Extension tabs occupy the non-scrolling header instead of a sticky content overlay', () => {
  const modal = read('features/settings/api/SettingsModal.tsx');
  const layout = read('features/settings/components/SettingsLayout.tsx');
  const header = read('features/settings/components/SettingsTopBar.tsx');
  const page = read('features/extensions/components/GlobalExtensionsPage.tsx');
  assert.match(modal, /searchReplacement=\{activeTab === "extensions" \? <SegmentedControl/);
  assert.match(modal, /searchPlaceholder=\{activeTab !== "extensions"/);
  assert.match(modal, /<GlobalExtensionsPage activeTab=\{extensionTab\}/);
  assert.doesNotMatch(page, /sticky|SegmentedControl/);
  assert.match(header, /ui-settings-topbar[^\n]*shrink-0/);
  assert.match(header, /searchReplacement \? <div[^\n]*: searchPlaceholder &&/);
  assert.match(layout, /<SettingsTopBar[\s\S]*\/>\s*<div className="min-h-0 flex-1 overflow-y-auto/);
});

test('Native apply has no second import flow; the MCP list keeps its import dialog', () => {
  const native = read('features/extensions/components/NativeMcpPanel.tsx');
  const mcp = read('features/extensions/components/GlobalMcpPanel.tsx');
  assert.doesNotMatch(native, /ExtensionImportDialog|extensions\.native\.import/);
  assert.match(native, /previewNativeMcp/);
  assert.doesNotMatch(native, /applyNativeMcp/);
  assert.match(mcp, /extensions\.mcp\.import/);
  assert.equal((mcp.match(/<ExtensionImportDialog/g) ?? []).length, 1);
});

test('Native configuration preview mounts only from its toolbar button', () => {
  const native = read('features/extensions/components/NativeMcpPanel.tsx');
  const mcp = read('features/extensions/components/GlobalMcpPanel.tsx');
  assert.match(mcp, /nativePreviewOpen && <NativeMcpPanel onClose=/);
  assert.match(mcp, /onClick=\{\(\) => setNativePreviewOpen\(true\)\}/);
  assert.match(native, /return\s*\(\s*<Modal\s+opened/);
  assert.match(native, /closeOnClickOutside=\{!busy\}\s+closeOnEscape=\{!busy\}/);
  assert.doesNotMatch(native, /<Card|extensions\.native\.title/);
});
