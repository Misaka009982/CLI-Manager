import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

async function dictionary(locale, name) {
  const source = readFileSync(new URL(`../src/shared/i18n/messages/extensions.${locale}.ts`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  return (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`))[name];
}
const zh = await dictionary('zh-CN', 'zh');
const en = await dictionary('en-US', 'en');

test('Every extension UI and API workflow translation literal exists in both languages', () => {
  const keys = new Set();
  for (const directory of ['components', 'api']) {
  const root = new URL(`../src/features/extensions/${directory}/`, import.meta.url);
  for (const file of readdirSync(root).filter(name => name.endsWith('.tsx'))) {
    const ast = ts.createSourceFile(file, readFileSync(new URL(file, root), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = node => {
      if (ts.isStringLiteral(node) && node.text.startsWith('extensions.')) keys.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  }
  assert.ok(keys.size > 50);
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh-CN missing ${key}`);
    assert.equal(typeof en[key], 'string', `en-US missing ${key}`);
  }
});
test('Extension dictionaries agree on keys and placeholders', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const key of Object.keys(zh)) assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key);
  for (const key of ['extensions.mcp.enableCli', 'extensions.mcp.disableCli']) {
    for (const messages of [zh, en]) assert.ok(messages[key].replace(/\{cli\}/g, 'Claude').includes('Claude'));
  }
});
