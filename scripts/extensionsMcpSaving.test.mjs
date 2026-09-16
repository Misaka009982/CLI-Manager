import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
async function load(relative) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
    .replace('from "zustand"', `from "${pathToFileURL(require.resolve('zustand')).href}"`);
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
const { pendingMcpClis, applyMcpTargets, saveMcpRevisionTargets } = await load('../src/features/extensions/lib/mcpPending.ts');
const { useMcpPendingStore: store, trackMcpMutation, beginMcpOperation, finishMcpOperation,
  acknowledgeMcpSave, discardMcpChanges } = await load('../src/features/extensions/state/mcpPendingStore.ts');

test('Track one CLI, retain on navigation, and acknowledge only the target Home', async () => {
  store.setState({ revisions: { claude: 0, codex: 0, grok: 0 }, applied: {}, operation: null, epoch: 0 });
  await trackMcpMutation(['claude'], async () => 'saved desired state');
  assert.deepEqual(pendingMcpClis(store.getState().revisions), ['claude']);
  // Changing views has no store reset; applying Home A never acknowledges Home B.
  acknowledgeMcpSave('home-a', 'claude', 1);
  assert.deepEqual(pendingMcpClis(store.getState().revisions, store.getState().applied['home-a']), []);
  assert.deepEqual(pendingMcpClis(store.getState().revisions, store.getState().applied['home-b']), ['claude']);
  await trackMcpMutation(['claude'], async () => true);
  assert.deepEqual(pendingMcpClis(store.getState().revisions, store.getState().applied['home-a']), ['claude']);
});

test('Failed edits and Skills-only imports do not mark MCP dirty', async () => {
  const before = store.getState().revisions;
  await assert.rejects(trackMcpMutation(['codex'], async () => { throw Error('failed'); }));
  await trackMcpMutation(['claude', 'codex', 'grok'], async () => ({ mcp: false }), result => result.mcp);
  assert.deepEqual(store.getState().revisions, before);
  assert.equal(store.getState().operation, null);
});

test('Save lock prevents edit races; read-only page entry cannot create pending revisions', async () => {
  beginMcpOperation('save');
  await assert.rejects(trackMcpMutation(['codex'], async () => true), /operation_busy/);
  acknowledgeMcpSave('home-a', 'claude', store.getState().revisions.claude);
  finishMcpOperation();
  assert.deepEqual(pendingMcpClis(store.getState().revisions, store.getState().applied['home-a']), []);
  const workflow = readFileSync(new URL('../src/features/extensions/api/mcpSaving.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /noteNativeMcpDifference|preview\.changed/);
  store.setState({ revisions: { claude: 0, codex: 0, grok: 0 }, applied: {} });
  assert.deepEqual(pendingMcpClis(store.getState().revisions), []);
});

test('Save partial success acknowledges successes and retries only failures', async () => {
  store.setState({ revisions: { claude: 1, codex: 1, grok: 1 }, applied: {}, operation: null });
  const calls = [];
  const failures = await applyMcpTargets(['claude', 'codex', 'grok'], async cli => {
    calls.push(cli);
    if (cli === 'codex') throw Error('conflict');
    acknowledgeMcpSave('home-a', cli, 1);
  });
  assert.deepEqual(calls, ['claude', 'codex', 'grok']);
  assert.deepEqual(failures.map(item => item.cli), ['codex']);
  assert.deepEqual(pendingMcpClis(store.getState().revisions, store.getState().applied['home-a']), ['codex']);
});

test('All requested settings leave routes use the same guard', () => {
  const modal = readFileSync(new URL('../src/features/settings/api/SettingsModal.tsx', import.meta.url), 'utf8');
  assert.match(modal, /mcpSave\.requestLeave\(onClose\)/);
  assert.match(modal, /mcpSave\.requestLeave\(change\)/);
  assert.match(modal, /mcpSave\.requestLeave\(\(\) => setExtensionTab/);
  const workflow = readFileSync(new URL('../src/features/extensions/api/mcpSaving.tsx', import.meta.url), 'utf8');
  assert.match(workflow, /if \(ok\) leave\(\)/);
  assert.match(workflow, /current\.operation/);
});

test('Native save uses captured fingerprints and acknowledges only verified writes', async () => {
  const calls = [];
  const acknowledged = [];
  const errors = await saveMcpRevisionTargets('home-a', { claude: 4, codex: 2, grok: 0 }, ['claude', 'codex'], {
    homeIdentity: async () => 'home-a',
    preview: async cli => ({ fingerprint: `preview-${cli}` }),
    apply: async (cli, fingerprint) => { calls.push([cli, fingerprint]); if (cli === 'codex') throw Error('external conflict'); },
    acknowledge: (cli, revision) => acknowledged.push([cli, revision]),
  });
  assert.deepEqual(calls, [['claude', 'preview-claude'], ['codex', 'preview-codex']]);
  assert.deepEqual(acknowledged, [['claude', 4]]);
  assert.deepEqual(errors.map(item => item.cli), ['codex']);
});

test('Changing Home after preview prevents native writes and acknowledgements', async () => {
  let identity = 'home-a';
  const errors = await saveMcpRevisionTargets('home-a', { claude: 1, codex: 0, grok: 0 }, ['claude'], {
    homeIdentity: async () => identity,
    preview: async () => { identity = 'home-b'; return { fingerprint: 'old-preview' }; },
    apply: async () => assert.fail('must not write to a different Home'),
    acknowledge: () => assert.fail('must remain pending'),
  });
  assert.equal(errors.length, 1);
});

// Evaluate the production workflow handlers against the real store, without desktop startup.
function workflowHandler(name, bindings) {
  const source = readFileSync(new URL('../src/features/extensions/api/mcpSaving.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('mcpSaving.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(initializer, `missing ${name}`);
  if (ts.isCallExpression(initializer)) initializer = initializer.arguments[0];
  const js = ts.transpileModule(`const handler = ${initializer.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(bindings), `${js}\nreturn handler;`)(...Object.values(bindings));
}

function leaveWorkflow(overrides = {}) {
  const view = { open: false, opens: 0, waits: 0 };
  const bindings = {
    enabled: true, homeIdentity: 'home-a', checking: false,
    continuation: { current: null }, useMcpPendingStore: store,
    pendingMcpClis, discardMcpChanges, t: key => key,
    toast: { info: () => { view.waits++; } },
    setFailure: () => {},
    setLeaveOpen: value => { view.open = value; if (value) view.opens++; },
    ...overrides,
  };
  bindings.cancelLeave = workflowHandler('cancelLeave', bindings);
  bindings.leave = workflowHandler('leave', bindings);
  return { view, ...bindings, requestLeave: workflowHandler('requestLeave', bindings),
    discardAndLeave: workflowHandler('discardAndLeave', bindings) };
}

test('Discard ends only this Home batch, without rolling back revisions or acknowledging writes', async () => {
  store.setState({ revisions: { claude: 3, codex: 2, grok: 1 },
    applied: { 'home-a': { claude: 3 } }, discarded: {}, operation: null });
  const before = store.getState();
  assert.equal(discardMcpChanges('home-a'), true);
  const current = store.getState();
  assert.deepEqual(current.revisions, before.revisions);
  assert.deepEqual(current.applied, before.applied);
  assert.deepEqual(pendingMcpClis(current.revisions, current.applied['home-a'], current.discarded['home-a']), []);
  assert.deepEqual(pendingMcpClis(current.revisions, current.applied['home-b'], current.discarded['home-b']), ['claude', 'codex', 'grok']);
  await trackMcpMutation(['codex'], async () => true);
  assert.deepEqual(pendingMcpClis(store.getState().revisions, current.applied['home-a'], current.discarded['home-a']), ['codex']);
  assert.equal(current.discarded['home-a'].codex, 2, 'discard must capture a snapshot');
});

test('One dialog owns repeated navigation; discard leaves once and does not prompt again on re-entry', async () => {
  store.setState({ revisions: { claude: 1, codex: 0, grok: 0 }, applied: {}, discarded: {}, operation: null });
  const flow = leaveWorkflow();
  const calls = [];
  flow.requestLeave(() => calls.push('first'));
  flow.requestLeave(() => calls.push('second'));
  assert.equal(flow.view.opens, 1);
  flow.discardAndLeave();
  flow.discardAndLeave();
  assert.deepEqual(calls, ['first']);
  assert.equal(flow.view.open, false);
  const reopened = leaveWorkflow();
  reopened.requestLeave(() => calls.push('reopened'));
  assert.equal(reopened.view.opens, 0);
  assert.deepEqual(calls, ['first', 'reopened']);
  await trackMcpMutation(['claude'], async () => true);
  reopened.requestLeave(() => calls.push('new-edit'));
  assert.equal(reopened.view.opens, 1);
  assert.equal(reopened.view.open, true);
});

test('Stay retains edits; checking and in-flight operations cannot discard or navigate', () => {
  store.setState({ revisions: { claude: 1, codex: 1, grok: 0 }, applied: {}, discarded: {}, operation: null });
  const flow = leaveWorkflow();
  let navigated = false;
  flow.requestLeave(() => { navigated = true; });
  flow.cancelLeave();
  assert.equal(navigated, false);
  assert.deepEqual(store.getState().discarded, {});
  flow.requestLeave(() => { navigated = true; });
  beginMcpOperation('edit');
  flow.discardAndLeave();
  assert.equal(navigated, false);
  assert.deepEqual(store.getState().discarded, {});
  finishMcpOperation();
  beginMcpOperation('save');
  assert.equal(discardMcpChanges('home-a'), false);
  finishMcpOperation();
  const checking = leaveWorkflow({ checking: true });
  checking.requestLeave(() => assert.fail('checking cannot navigate'));
  assert.equal(checking.view.waits, 1);
  assert.equal(checking.view.open, false);
});

test('Partial apply remains pending; cancel keeps successful acknowledgements and does not write again', async () => {
  store.setState({ revisions: { claude: 2, codex: 2, grok: 0 }, applied: {}, discarded: {}, operation: null });
  const writes = [];
  const flow = leaveWorkflow();
  let navigated = false;
  flow.requestLeave(() => { navigated = true; });
  const save = workflowHandler('save', {
    useMcpPendingStore: store, beginMcpOperation, finishMcpOperation, pendingMcpClis,
    saveMcpRevisionTargets, acknowledgeMcpSave,
    home: { identity: { identity: 'home-a' } },
    getActiveNativeProviderHome: async () => ({ identity: { identity: 'home-a' } }),
    previewNativeMcp: async () => ({ fingerprint: 'captured' }),
    applyNativeMcp: async cli => { writes.push(cli); if (cli === 'codex') throw Error('conflict'); },
    setFailure: () => {}, setHome: () => {}, t: key => key, toast: { success: () => {}, error: () => {} },
  });
  assert.equal(await save(), false);
  assert.equal(navigated, false);
  assert.equal(flow.view.open, true);
  flow.discardAndLeave();
  assert.equal(navigated, true);
  assert.deepEqual(store.getState().applied['home-a'], { claude: 2 });
  await save();
  assert.deepEqual(writes, ['claude', 'codex'], 'save must not replay a discarded batch');
});

test('Confirmation ignores outside clicks; settings backdrop checks the actual event origin', () => {
  const workflow = readFileSync(new URL('../src/features/extensions/api/mcpSaving.tsx', import.meta.url), 'utf8');
  const modal = readFileSync(new URL('../src/features/settings/api/SettingsModal.tsx', import.meta.url), 'utf8');
  assert.match(workflow, /closeOnClickOutside=\{false\}/);
  assert.match(workflow, /onClick=\{discardAndLeave\}/);
  assert.match(modal, /if \(event\.target === event\.currentTarget\) requestClose\("backdrop"\)/);
  assert.match(workflow, /snapshot\.discarded\[identity\]/);
  assert.match(workflow, /state\.discarded\[homeIdentity\]/);
});
