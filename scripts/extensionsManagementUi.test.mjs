import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const read = name => readFileSync(new URL(`../src/features/extensions/components/${name}.tsx`, import.meta.url), 'utf8');

// Execute the component's actual async closures with deferred IPC, without starting the desktop app.
function closure(component, name, bindings) {
  const ast = ts.createSourceFile('component.tsx', read(component), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(initializer, `${component}.${name} must exist`);
  if (ts.isCallExpression(initializer)) initializer = initializer.arguments[0];
  const js = ts.transpileModule(`const handler = ${initializer.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(bindings), `${js}\nreturn handler;`)(...Object.values(bindings));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test('Native preview keeps the latest CLI result when an earlier request fails late', async () => {
  const old = deferred();
  const current = deferred();
  const state = { preview: null, busy: false, error: null };
  const inspect = closure('NativeMcpPanel', 'inspect', {
    requestIdRef: { current: 0 },
    setBusy: value => { state.busy = value; },
    setError: value => { state.error = value; },
    setPreview: value => { state.preview = value; },
    previewNativeMcp: cli => cli === 'claude' ? old.promise : current.promise,
    nativeErrorCode: () => 'old-error',
  });
  const first = inspect('claude');
  const second = inspect('codex');
  const codex = { cli: 'codex', format: 'toml', content: '[mcp_servers]' };
  current.resolve(codex);
  await second;
  old.reject(new Error('obsolete request'));
  await first;
  assert.deepEqual(state, { preview: codex, busy: false, error: null });
});

test('Native preview ignores success after the dialog request generation is invalidated', async () => {
  const pending = deferred();
  const generation = { current: 0 };
  const updates = [];
  const inspect = closure('NativeMcpPanel', 'inspect', {
    requestIdRef: generation,
    setBusy: value => updates.push(['busy', value]),
    setError: value => updates.push(['error', value]),
    setPreview: value => updates.push(['preview', value]),
    previewNativeMcp: () => pending.promise,
    nativeErrorCode: () => 'unused',
  });
  const request = inspect('claude');
  generation.current += 1;
  const before = [...updates];
  pending.resolve({ cli: 'claude' });
  await request;
  assert.deepEqual(updates, before);
});

test('CLI selection invalidates the old preview before the next effect starts', async () => {
  const pending = deferred();
  const generation = { current: 0 };
  const state = { cli: 'claude', preview: null, error: null };
  const bindings = {
    requestIdRef: generation,
    setPreview: value => { state.preview = value; },
    setError: value => { state.error = value; },
  };
  const inspect = closure('NativeMcpPanel', 'inspect', {
    ...bindings, setBusy: () => {}, previewNativeMcp: () => pending.promise, nativeErrorCode: () => 'unused',
  });
  const select = closure('NativeMcpPanel', 'selectCli', {
    ...bindings, cli: 'claude', CLI_ORDER: ['claude', 'codex', 'grok'], setCli: value => { state.cli = value; },
  });
  const request = inspect('claude');
  select('codex');
  pending.resolve({ cli: 'claude', content: 'old content' });
  await request;
  assert.deepEqual(state, { cli: 'codex', preview: null, error: null });
});

test('Project bulk selection preserves filtered-out IDs and the selected same-name source', () => {
  const updates = [];
  const bindings = {
    canCustomize: true, loading: false, saving: false,
    currentDraft: { mode: 'inherit', selectedIds: [] },
    effectiveIds: ['hidden', 'variant-b'],
    resources: [{ ids: ['variant-a', 'variant-b'] }, { ids: ['new'] }],
    updateDraft: value => updates.push(value),
  };
  const toggle = closure('ProjectExtensionsDialog', 'toggleAllVisible', bindings);
  toggle(true);
  assert.deepEqual(updates.pop(), { mode: 'custom', selectedIds: ['hidden', 'variant-b', 'new'] });
  toggle(false);
  assert.deepEqual(updates.pop(), { mode: 'custom', selectedIds: ['hidden'] });
  for (const guard of [{ canCustomize: false }, { loading: true }, { saving: true }, { currentDraft: null }]) {
    closure('ProjectExtensionsDialog', 'toggleAllVisible', { ...bindings, ...guard })(true);
    assert.equal(updates.length, 0);
  }
});

test('Skill uninstall immediately calls the target IPC and preserves protection and locking', async () => {
  const pending = deferred();
  const workingRef = { current: false };
  const calls = [];
  const notices = [];
  let refreshed = 0;
  const bindings = {
    workingRef, setWorking: () => {},
    confirm: () => assert.fail('No second confirmation for uninstall'),
    uninstallManagedSkill: id => { calls.push(id); return pending.promise; },
    toast: { success: value => notices.push(value), error: value => notices.push(value) },
    t: key => key, onRefresh: async () => { refreshed++; },
  };
  const uninstall = closure('GlobalSkillsPanel', 'uninstall', bindings);
  const record = { installationId: 'target', cli: 'claude', owned: true, externalModified: false };
  const pkg = { packageId: 'source', name: 'demo' };
  await uninstall({ ...record, owned: false }, pkg);
  await uninstall({ ...record, externalModified: true }, pkg);
  assert.deepEqual(calls, []);
  const operation = uninstall(record, pkg);
  assert.deepEqual(calls, ['target']);
  await uninstall(record, pkg);
  assert.equal(calls.length, 1);
  pending.resolve({ removed: true });
  await operation;
  assert.equal(workingRef.current, false);
  assert.equal(refreshed, 1);
  assert.deepEqual(notices, ['extensions.skills.uninstallSuccess']);
  await closure('GlobalSkillsPanel', 'uninstall', {
    ...bindings, uninstallManagedSkill: async () => ({ removed: false }),
  })(record, pkg);
  assert.equal(notices.at(-1), 'extensions.skills.uninstallFailed');
  assert.equal(workingRef.current, false);
});

test('Project resource description labels activate the same native checkbox as the name', () => {
  const source = read('ProjectExtensionsDialog');
  assert.match(source, /name=\{<label htmlFor=\{`\$\{dialogId\}-\$\{resource.id\}`\}/);
  assert.match(source, /description=\{<label htmlFor=\{`\$\{dialogId\}-\$\{resource.id\}`\}/);
  assert.match(source, /id=\{`\$\{dialogId\}-\$\{resource.id\}`\}\s+type="checkbox"/);
  assert.match(source, /disabled=\{!editableSelection\}/);
  assert.match(source, /onChange=\{\(\) => toggleSelection\(resource.ids\)\}/);
});

for (const failed of [false, true]) {
  test(`GitHub cancellation ${failed ? 'failure' : 'acknowledgement'} does not unlock the original operation`, async () => {
    const pending = deferred();
    const flags = [];
    const errors = [];
    const cancel = closure('GithubSkillDialog', 'cancel', {
      activeOperationId: 'operation-1',
      cancelling: false,
      setCancelling: value => flags.push(value),
      setBusy: () => assert.fail('Only the original operation can release busy'),
      cancelGithubSkill: id => { assert.equal(id, 'operation-1'); return pending.promise; },
      setError: value => errors.push(value),
      t: key => key,
    });
    const request = cancel();
    assert.deepEqual(flags, [true]);
    if (failed) pending.reject(new Error('cancel failed'));
    else pending.resolve();
    await request;
    assert.deepEqual(flags, [true, false]);
    assert.deepEqual(errors, [failed ? 'extensions.errors.generic' : 'extensions.skills.githubCancelled']);
  });
}
