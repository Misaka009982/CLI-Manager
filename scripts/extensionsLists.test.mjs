import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const read = path => readFileSync(new URL(`../src/features/extensions/${path}`, import.meta.url), 'utf8');
async function evaluate(source) {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
const { sortExtensions, skillCliPresentation, groupSkillPackages } = await evaluate(read('lib/listPresentation.ts'));
const panel = read('components/GlobalSkillsPanel.tsx');
const ast = ts.createSourceFile('panel.tsx', panel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node)
  && ['normalizePath', 'isCurrentInstallation'].includes(node.name?.text));
const { isCurrentInstallation } = await evaluate(functions.map(node => `export ${node.getText(ast)}`).join('\n'));

test('Name ordering is natural, stable, reversible, and does not mutate records', () => {
  const records = [{ name: 'tool10' }, { name: 'Tool2' }, { name: 'alpha' }, { name: 'ALPHA' }];
  const original = [...records];
  assert.deepEqual(sortExtensions(records, 'nameAsc').map(item => item.name), ['alpha', 'ALPHA', 'Tool2', 'tool10']);
  assert.deepEqual(sortExtensions(records, 'nameDesc').map(item => item.name), ['tool10', 'Tool2', 'alpha', 'ALPHA']);
  assert.deepEqual(records, original);
  assert.deepEqual(sortExtensions([], 'nameAsc'), []);
});

const installation = { cli: 'claude', status: 'active', owned: true, externalModified: false };
test('Same-name source variants form one row without deleting distinct identities or content', () => {
  const items = [{ name: 'ai-search-hub', packageId: 'one', contentHash: 'a' },
    { name: 'doc', packageId: 'doc' }, { name: 'ai-search-hub', packageId: 'two', contentHash: 'b' }];
  const groups = groupSkillPackages(items);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], [items[0], items[2]]);
  assert.equal(items.length, 3);
});

test('Codex installation in shared directory does not imply three independent installations', () => {
  const items = [{ ...installation, cli: 'codex' }];
  const inventory = ['claude', 'codex', 'grok'].map(cli => ({ cli, name: 'ai-search-hub',
    sourceKind: 'agent-compatible', status: 'present', managed: cli === 'codex', path: '/home/me/.agents/skills/ai-search-hub' }));
  for (const cli of ['claude', 'codex', 'grok']) {
    const state = skillCliPresentation(items, cli, inventory, 'ai-search-hub');
    assert.equal(state.enabled, cli === 'codex');
    assert.equal(state.shared.length, cli === 'codex' ? 0 : 1);
  }
  // Existing unmanaged Codex target is still present and protected, not silently adopted.
  const external = skillCliPresentation([], 'codex', inventory.map(item => ({ ...item, managed: false })), 'ai-search-hub');
  assert.equal(external.enabled, true);
  assert.equal(external.blocked, true);
});

test('Target-specific inspection retains CLI and cannot become a destructive shortcut', () => {
  assert.doesNotMatch(panel, /extensions.skills.statusIncomplete/);
  assert.match(panel, /inventoryComplete\[cli\] === true/);
  assert.match(panel, /if \(state.blocked\) \{ setDeployCli\(cli\); setDeployPackage\(packageView\); return; \}/);
  assert.match(panel, /setCli\(targetCli \?\? "claude"\)/);
  assert.match(panel, /disabled=\{saving \|\| Boolean\(targetCli\)\}/);
});

test('Project dialog follows launch CLI resolution and never defaults unsupported projects to Claude', () => {
  const projectPanel = read('components/ProjectExtensionsDialog.tsx');
  assert.match(projectPanel, /getProviderSwitchAppType\(project\)/);
  assert.match(projectPanel, /const activeCli: ExtensionCli \| null/);
  assert.doesNotMatch(projectPanel, /setActiveCli|extensions.project.environment/);
  assert.match(projectPanel, /extensions.project.unsupportedCli/);
  assert.match(projectPanel, /\[activeCli\]\.flatMap/);
});

test('Project Skill policy rows group exact duplicate names while retaining source IDs', () => {
  const projectPanel = read('components/ProjectExtensionsDialog.tsx');
  assert.match(projectPanel, /return groupSkillPackages\(response\.packages\)/);
  assert.match(projectPanel, /ids: variants\.map\(\(packageView\) => packageView\.packageId\)/);
  assert.match(projectPanel, /ids\.some\(\(id\) => effectiveIds\.includes\(id\)\)/);
});

test('Project dialog keeps the modal stable and delegates long lists to the inner scroller', () => {
  const projectPanel = read('components/ProjectExtensionsDialog.tsx');
  assert.match(projectPanel, /<DialogContent className="flex h-\[92vh\] max-h-\[calc\(100vh-2rem\)\][^\"]*overflow-hidden/);
  assert.match(projectPanel, /<div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 py-4">/);
  assert.match(projectPanel, /<div className="grid min-h-0 flex-1 auto-rows-fr gap-4/);
  assert.match(projectPanel, /<div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">/);
});

test('Skill icons reflect active/missing installation and keep each CLI independent', () => {
  assert.equal(skillCliPresentation([installation], 'claude').enabled, true);
  assert.equal(skillCliPresentation([installation], 'codex').enabled, false);
  assert.equal(skillCliPresentation([{ ...installation, status: 'missing' }], 'claude').enabled, false);
  assert.equal(skillCliPresentation([], 'claude').blocked, false);
});

test('Protected, unreadable, foreign and duplicate installs cannot be removed by icon', () => {
  for (const changed of [{ externalModified: true }, { status: 'unreadable' }, { owned: false }, { status: 'externalModified' }]) {
    assert.equal(skillCliPresentation([{ ...installation, ...changed }], 'claude').blocked, true);
  }
  assert.equal(skillCliPresentation([installation, { ...installation }], 'claude').blocked, true);
});

test('Home matching preserves POSIX/WSL case while Windows paths ignore casing', () => {
  const home = (kind, id, path) => ({ identity: { environmentKind: kind, environmentId: id }, homePath: path });
  const record = (kind, id, path) => ({ environmentKind: kind, environmentId: id, homePath: path });
  assert.equal(isCurrentInstallation(record('local', 'local', 'C:/Users/Me'), home('local', 'local', 'c:\\users\\me\\')), true);
  assert.equal(isCurrentInstallation(record('local', 'local', '/Users/Me'), home('local', 'local', '/Users/me')), false);
  assert.equal(isCurrentInstallation(record('wsl', 'Ubuntu', '\\\\wsl$\\Ubuntu\\home\\me'), home('wsl', 'Ubuntu', '/home/me')), true);
  assert.equal(isCurrentInstallation(record('wsl', 'Ubuntu', '/home/Me'), home('wsl', 'Ubuntu', '/home/me')), false);
  assert.equal(isCurrentInstallation(record('wsl', 'Debian', '/home/me'), home('wsl', 'Ubuntu', '/home/me')), false);
});

test('Both lists reuse sort/icon controls; dense Skill metadata defaults to collapsed', () => {
  for (const file of ['GlobalMcpPanel', 'GlobalSkillsPanel']) {
    const source = read(`components/${file}.tsx`);
    assert.match(source, /<ExtensionSortableList/);
    assert.match(source, /<ExtensionCliToggle/);
    assert.match(source, /<ExtensionCompactRow[\s\S]*?leading=\{dragHandle\}/);
  }
  const row = read('components/ExtensionCompactRow.tsx');
  assert.ok(row.indexOf('{leading}') < row.indexOf('{name}'));
  assert.match(panel, /truncate title=\{packageView.description\}/);
  assert.match(panel, /useState<Record<string, boolean>>\(\{\}\)/);
  assert.match(panel, /aria-expanded=\{Boolean\(expandedGroups\[group.packageId\]\)\}/);
  assert.ok(panel.indexOf('{expandedGroups[group.packageId] &&') < panel.indexOf('{packageView.sourceIdentity}'));
  assert.match(panel, /mode: "auto"/);
  assert.match(panel, /if \(!result\.removed\) throw/);
});

test('External same-name Skills are visible but never treated as owned; partial scans are not absence', () => {
  const entries = [{ cli: 'claude', name: 'docx', path: '/home/me/.claude/skills/docx', status: 'present', managed: false }];
  const state = skillCliPresentation([], 'claude', entries, 'docx');
  assert.equal(state.enabled, true);
  assert.equal(state.blocked, true);
  assert.equal(state.installation, undefined);
  assert.equal(skillCliPresentation([], 'codex', entries, 'docx').enabled, false);
  assert.equal(skillCliPresentation([], 'claude', entries, 'other').enabled, false);
  assert.equal(skillCliPresentation([], 'claude', [], 'docx', false).blocked, true);
  assert.equal(skillCliPresentation([], 'claude', [{ ...entries[0], status: 'missing' }], 'docx').enabled, false);
});
