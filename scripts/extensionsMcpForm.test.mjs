import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSync } from 'esbuild';

// 打包执行真实模块，包括 Monaco 自带 AST，避免把数据测试降为源码匹配。
async function load(file) {
  const code = buildSync({ entryPoints: [`src/features/extensions/lib/${file}.ts`], bundle: true,
    write: false, format: 'esm', platform: 'node' }).outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const { createMcpFormDraft, mcpFormResource, mergeMcpJsonDraft, validateMcpForm, newArgumentRow, newKeyValueRow,
  maskedValueMoved, mcpDraftFingerprint } = await load('mcpFormDraft');
const { parseMcpEditorJson, mcpEditorJson } = await load('mcpJsonEditor');
const { applyMcpTemplate, mcpTemplates } = await load('mcpTemplates');
const { mcpFieldSuggestions } = await load('mcpFieldSuggestions');
const parse = config => parseMcpEditorJson(JSON.stringify({ mcpServers: { example: config } }), null);

test('round trips preserve unknown nested fields, identity, metadata and non-Claude extras', () => {
  const original = { ...parse({ command: 'tool', args: ['', ' a '], env: { X: '' }, custom: { nested: [1, null] } }),
    extra: { revision: 4 }, redactedFields: [], name: 'Friendly' };
  original.perCliExtensions.codex = { custom: true };
  const draft = createMcpFormDraft(original);
  assert.deepEqual(mcpFormResource(draft), (({ redactedFields, ...rest }) => rest)(original));
  const json = mcpEditorJson(mcpFormResource(draft));
  assert.deepEqual(mcpFormResource(mergeMcpJsonDraft(draft, parseMcpEditorJson(json, original))), mcpFormResource(draft));
  assert.equal(mcpDraftFingerprint(mergeMcpJsonDraft(draft, parseMcpEditorJson(json, original))), mcpDraftFingerprint(draft));
  const deleted = JSON.parse(json); delete deleted.mcpServers.example.custom;
  assert.deepEqual(mergeMcpJsonDraft(draft, parseMcpEditorJson(JSON.stringify(deleted), original)).snapshot.perCliExtensions.claude, {});
});

test('transport cache restores inputs and only projects fields of the active transport', () => {
  const draft = createMcpFormDraft(parse({ command: 'cmd', args: ['-x'], cwd: 'C:/work', env: { X: 'a' } }));
  draft.transport = 'streamableHttp'; draft.fields.streamableHttp.url = 'http://localhost:3000/mcp';
  assert.equal(mcpFormResource(draft).command, null);
  assert.deepEqual(mcpFormResource(draft).args, []);
  draft.transport = 'sse'; draft.fields.sse.url = 'http://localhost/events';
  draft.transport = 'stdio';
  assert.equal(mcpFormResource(draft).command, 'cmd');
  assert.equal(mcpFormResource(draft).url, null);
  assert.deepEqual(mcpFormResource(draft).headers, {});
});

test('stable rows preserve explicit empty strings, order, whitespace and reject ambiguous maps', () => {
  const draft = createMcpFormDraft(parse({ command: 'cmd' }));
  draft.fields.stdio.args = [newArgumentRow(), newArgumentRow('', true), newArgumentRow(' a '), newArgumentRow('b')];
  assert.deepEqual(mcpFormResource(draft).args, ['', ' a ', 'b']);
  draft.fields.stdio.env = [newKeyValueRow(), newKeyValueRow('EMPTY', ''), newKeyValueRow('Case', '1'), newKeyValueRow('case', '2')];
  assert.deepEqual(mcpFormResource(draft).env, { EMPTY: '', Case: '1', case: '2' });
  assert.equal(validateMcpForm(draft, null).length, 0);
  draft.fields.stdio.env.push(newKeyValueRow('EMPTY', 'bad'), newKeyValueRow('', 'value'));
  assert.deepEqual(validateMcpForm(draft, null).map(issue => issue.code), ['duplicate', 'keyRequired']);
  draft.transport = 'streamableHttp'; draft.fields.streamableHttp.url = 'http://localhost/mcp';
  draft.fields.streamableHttp.headers = [newKeyValueRow('Authorization', 'a'), newKeyValueRow('authorization', 'b')];
  assert.equal(validateMcpForm(draft, null)[0].code, 'duplicate');
});

test('strict AST rejects duplicates at every depth including escaped property names', () => {
  for (const json of [
    '{"mcpServers":{"a":{"command":"x","command":"y"}}}',
    '{"mcpServers":{"a":{"command":"x","env":{"A":"1","\\u0041":"2"}}}}',
    '{"mcpServers":{"a":{"command":"x","vendor":[{"x":1,"x":2}]}}}',
  ]) assert.throws(() => parseMcpEditorJson(json, null), /duplicate/);
  assert.throws(() => parseMcpEditorJson('{"mcpServers":{/* comment */}}', null));
  assert.doesNotThrow(() => parseMcpEditorJson('{"mcpServers":{"a":{"command":"x","vendor":{"a":1},"other":{"a":2}}}}', null));
});

test('redacted paths may stay, replace or delete, but not move to another key or group', () => {
  const original = { ...parse({ command: 'cmd', env: { TOKEN: '[redacted]' } }), extra: {}, redactedFields: ['env.TOKEN'] };
  const draft = createMcpFormDraft(original);
  assert.deepEqual(validateMcpForm(draft, original), []);
  draft.fields.stdio.env[0].key = 'OTHER';
  assert.equal(validateMcpForm(draft, original)[0].code, 'secretMoved');
  assert.equal(maskedValueMoved(mcpFormResource(draft), original), true);
  draft.fields.stdio.env[0].value = 'example-new-token';
  assert.deepEqual(validateMcpForm(draft, original), []);
  draft.fields.stdio.env = [];
  assert.deepEqual(mcpFormResource(draft).env, {});
  const nested = mcpFormResource(draft);
  nested.perCliExtensions = { ...nested.perCliExtensions, claude: { secret: '[redacted]' } };
  assert.equal(maskedValueMoved(nested, original), true);
});

test('templates replace credentials, preserve custom names, and generic releases constraints without clearing', () => {
  let draft = createMcpFormDraft(null); draft.name = 'my-tools';
  draft = applyMcpTemplate(draft, 'generic', 'baizhi');
  draft.fields.streamableHttp.headers[0].value = 'Bearer example-only';
  const next = applyMcpTemplate(draft, 'baizhi', 'composio');
  assert.equal(next.name, 'my-tools'); assert.equal(next.snapshot.resourceId, draft.snapshot.resourceId);
  assert.deepEqual(mcpFormResource(next).headers, {});
  assert.equal(applyMcpTemplate(next, 'composio', 'generic'), next);
  assert.equal(draft.fields.streamableHttp.headers[0].value, 'Bearer example-only');
  assert.deepEqual(mcpTemplates.map(item => item.id), ['generic', 'baizhi', 'modelscope', 'smithery', 'composio']);
  assert.equal(applyMcpTemplate(createMcpFormDraft(null), 'generic', 'modelscope').fields.streamableHttp.url, '');
});

test('suggestions include common auth names in env without changing their storage destination', () => {
  for (const group of ['headers', 'env']) {
    assert.equal(mcpFieldSuggestions(group, 'au', [])[0], 'Authorization');
    for (const name of ['Authorization', 'Cookie', 'X-Auth-Token', 'Api-Key', 'OpenAI-Project']) {
      assert.ok(mcpFieldSuggestions(group, '', []).includes(name));
    }
  }
  assert.deepEqual(mcpFieldSuggestions('headers', 'authorization', ['AUTHORIZATION']), []);
  assert.deepEqual(mcpFieldSuggestions('env', 'authorization', ['Authorization']), []);
  assert.deepEqual(mcpFieldSuggestions('env', 'authorization', ['AUTHORIZATION']), ['Authorization']);
  assert.equal(mcpFieldSuggestions('env', '', [], ['CUSTOM_TOKEN'])[0], 'CUSTOM_TOKEN');
  assert.ok(mcpFieldSuggestions('env', '', []).includes('GITHUB_TOKEN'));
  assert.ok(mcpFieldSuggestions('env', 'proxy', []).includes('ALL_PROXY'));
  assert.ok(mcpFieldSuggestions('headers', '', []).includes('Accept-Language'));
  assert.ok(mcpFieldSuggestions('headers', '', []).includes('X-Request-ID'));
  assert.deepEqual(mcpFieldSuggestions('headers', 'accept', ['ACCEPT']), ['Accept-Language', 'Accept-Encoding']);
  const draft = createMcpFormDraft(parse({ command: 'x', env: { CUSTOM_NAME: 'value', Authorization: 'example-only' } }));
  assert.deepEqual(validateMcpForm(draft, null), []);
  assert.equal(mcpFormResource(draft).env.Authorization, 'example-only');
  assert.deepEqual(mcpFormResource(draft).headers, {});
});
