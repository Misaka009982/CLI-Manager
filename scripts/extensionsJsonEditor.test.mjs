import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const read = path => readFileSync(new URL(`../src/features/extensions/${path}`, import.meta.url), 'utf8');
const js = ts.transpileModule(read('lib/mcpJsonEditor.ts'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { mcpEditorJson, parseMcpEditorJson } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('Common MCP JSON round trip preserves environment references and hides bookkeeping', () => {
  const input = { mcpServers: { github: { command: 'npx', args: ['-y', '@anthropic/mcp-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } } } };
  const resource = parseMcpEditorJson(JSON.stringify(input), null);
  assert.equal(resource.serverKey, 'github');
  assert.equal(resource.env.GITHUB_TOKEN, '${GITHUB_TOKEN}');
  assert.equal(resource.enabledByCli.claude, false);
  assert.deepEqual(JSON.parse(mcpEditorJson(resource)), input);
  assert.doesNotMatch(mcpEditorJson(resource), /resourceId|schemaVersion|enabledByCli|perCliExtensions/);
});

test('Editing preserves hidden metadata and supports unchanged, replaced and removed secret fields', () => {
  const original = { ...parseMcpEditorJson('{"mcpServers":{"a":{"command":"x","env":{"TOKEN":"***"}}}}', null),
    name: 'Friendly', source: { kind: 'ccswitch' }, extra: { revision: 9 }, redactedFields: ['env.TOKEN'],
    perCliExtensions: { claude: { custom: true }, codex: { tool_timeout_sec: 20 } } };
  const edited = parseMcpEditorJson(mcpEditorJson(original), original);
  for (const key of ['resourceId', 'name', 'source', 'extra', 'perCliExtensions', 'env']) assert.deepEqual(edited[key], original[key]);
  const replacement = JSON.parse(mcpEditorJson(original));
  replacement.mcpServers.a.env.TOKEN = 'new-secret';
  assert.equal(parseMcpEditorJson(JSON.stringify(replacement), original).env.TOKEN, 'new-secret');
  delete replacement.mcpServers.a.env;
  assert.deepEqual(parseMcpEditorJson(JSON.stringify(replacement), original).env, {});
});

test('Malformed shapes, invalid fields and multiple servers are rejected, not silently dropped', () => {
  for (const value of ['null', '[]', '{}', '{"mcpServers":{}}', '{"mcpServers":{"a":{},"b":{}}}',
    '{"mcpServers":{"a":{"args":"wrong"}}}', '{"mcpServers":{"a":{"env":{"X":1}}}}',
    '{"mcpServers":{"a":{"type":"unknown"}}}', '{"mcpServers":{"a":{}},"unrelated":1}']) {
    assert.throws(() => parseMcpEditorJson(value, null));
  }
  assert.equal(parseMcpEditorJson('{"mcpServers":{"a":{"type":"http","url":"https://example.test"}}}', null).transport, 'streamableHttp');
});

test('Bounded JSON editor and handle-only persistent sorting replace old controls', () => {
  const editor = read('components/McpEditorDialog.tsx');
  assert.ok(editor.indexOf('</div>') < editor.indexOf('<Group justify="flex-end"'));
  assert.match(editor, /38dvh/);
  assert.doesNotMatch(editor, /McpResourceForm|SegmentedControl|minRows=\{18\}/);
  assert.doesNotMatch(read('components/GlobalMcpPanel.tsx'), /ProjectionDialog|extensions\.mcp\.capabilities|ExtensionSortSelect/);
  const order = read('components/ExtensionSortableList.tsx');
  for (const token of ['setActivatorNodeRef', 'KeyboardSensor', 'extension-list-order.json']) assert.ok(order.includes(token));
  assert.doesNotMatch(order, /trackMcpMutation/);
});
