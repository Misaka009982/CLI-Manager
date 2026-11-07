import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { buildProjectTree, expandedProjectPathKeys, filterProjectTree } from "./projectTree.ts";
import { translator } from "./i18n.ts";

const project = (id, name, groupId, sortOrder, cwd = `/work/${id}`) => ({
  id, name, groupId, sortOrder, cwd, source: "codex", environmentType: "local",
});
function fixture() {
  return {
    groups: [
      { id: "nested", name: "Frontend", parentId: "dev", sortOrder: 2 },
      { id: "empty", name: "Empty", parentId: null, sortOrder: 30 },
      { id: "dev", name: "Development", parentId: null, sortOrder: 20 },
    ],
    projects: [
      project("second", "CLI-Manager", "dev", 3), project("first", "CLI-Manager", "nested", 1),
      project("orphan", "Orphan", "missing", 40), project("root", "Root", null, 10),
      { ...project("ssh", "SSH", "dev", 4), environmentType: "ssh" },
    ],
    worktrees: [{ id: "wt", projectId: "first", name: "Feature checkout", branch: "feature/test", status: "active" }],
    terminals: [{ sessionId: "pty-1", projectId: "first", worktreeId: "wt", title: "Fix session" }], updatedAt: 1,
  };
}
const flatten = (nodes) => nodes.flatMap((node) => [node, ...(node.kind === "group" ? flatten(node.children) : [])]);

test("desktop groups and projects share sibling order; duplicate names retain IDs and sessions", () => {
  const workspace = fixture();
  const original = structuredClone(workspace);
  const tree = buildProjectTree(workspace);
  assert.deepEqual(tree.map((node) => node.key), ["project:root", "group:dev", "group:empty", "project:orphan"]);
  assert.deepEqual(tree[1].children.map((node) => node.key), ["group:nested", "project:second", "project:ssh"]);
  const nodes = flatten(tree);
  const sameNames = nodes.filter((node) => node.kind === "project" && node.project.name === "CLI-Manager");
  assert.equal(sameNames.length, 2);
  assert.ok(sameNames.every((node) => node.duplicateName));
  assert.deepEqual(sameNames.map((node) => node.sessions.length), [1, 0]);
  assert.equal(sameNames[0].sessions[0].worktreeId, "wt");
  assert.deepEqual(workspace, original, "tree construction does not mutate cached snapshot arrays");
});

test("orphan/cyclic groups remain reachable once, and group/project IDs have separate keys", () => {
  const workspace = fixture();
  workspace.groups = [
    { id: "first", name: "A", parentId: "b", sortOrder: 1 },
    { id: "b", name: "B", parentId: "first", sortOrder: 2 },
    { id: "self", name: "Self", parentId: "self", sortOrder: 3 },
    { id: "lost", name: "Lost", parentId: "absent", sortOrder: 4 },
  ];
  workspace.projects[0].groupId = "b";
  workspace.projects[1].groupId = "self";
  const nodes = flatten(buildProjectTree(workspace));
  assert.equal(nodes.length, workspace.groups.length + workspace.projects.length);
  assert.equal(new Set(nodes.map((node) => node.key)).size, nodes.length);
});

test("default expansion follows active project IDs through every ancestor without opening siblings", () => {
  const tree = buildProjectTree(fixture());
  assert.deepEqual([...expandedProjectPathKeys(tree, new Set())], []);
  assert.deepEqual([...expandedProjectPathKeys(tree, new Set(["first"]))].sort(), ["group:dev", "group:nested", "project:first"]);
  assert.deepEqual([...expandedProjectPathKeys(tree, new Set(["first", "second", "root", "unknown"]))].sort(),
    ["group:dev", "group:nested", "project:first", "project:root", "project:second"]);
});

test("search keeps group ancestry, empty projects, paths and worktree/session matches", () => {
  const workspace = fixture();
  const tree = buildProjectTree(workspace);
  const keys = (query) => flatten(filterProjectTree(tree, query, workspace)).map((node) => node.key);
  assert.deepEqual(keys("/work/second"), ["group:dev", "project:second"]);
  assert.deepEqual(keys("Fix session"), ["group:dev", "group:nested", "project:first"]);
  assert.deepEqual(keys("feature/test"), ["group:dev", "group:nested", "project:first"]);
  assert.deepEqual(keys("Frontend"), ["group:dev", "group:nested", "project:first"]);
  assert.deepEqual(keys("Development"), ["group:dev", "group:nested", "project:first", "project:second", "project:ssh"]);
  assert.deepEqual(keys("Empty"), ["group:empty"]);
  assert.deepEqual(keys("not-found"), []);
  assert.equal(filterProjectTree(tree, "  ", workspace), tree);
});

// Render actual JSX/callbacks with a minimal host; no browser auth, CLI start or network calls.
function renderHarness(componentName, model, language = "zh-CN") {
  const require = createRequire(import.meta.url);
  const ts = require("typescript");
  const states = [];
  let cursor = 0;
  let tree;
  const starts = [];
  let closes = 0;
  const jsx = (type, props, key) => ({ type, props, key });
  const dependencies = {
    react: {
      useState(initial) {
        const index = cursor++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
      },
      useMemo: (factory) => factory(),
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "lucide-react": new Proxy({}, { get: (_, key) => key }),
    "./AgentIcon": { AgentIcon: "AgentIcon" }, "./Menu": { Menu: "Menu" },
    "./projectTree": { buildProjectTree, expandedProjectPathKeys, filterProjectTree },
    "./Sheet": { useSheetClose: () => () => { closes++; } }, "./preferences": {},
  };
  const file = componentName === "Sidebar" ? "Sidebar" : "Settings";
  const code = ts.transpileModule(readFileSync(new URL(`./${file}.tsx`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: (id) => {
    assert.ok(id in dependencies, id);
    return dependencies[id];
  } });
  const render = () => {
    cursor = 0;
    tree = exports[componentName]({ model, t: translator(language), phone: false,
      onPick() {}, onSettings() {}, onClose: () => { closes++; }, onStart: (...args) => starts.push(args) });
  };
  const walk = (node) => !node || typeof node !== "object" ? []
    : [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
  render();
  return { nodes: () => walk(tree), render, starts, get closes() { return closes; } };
}
function modelFixture() {
  const starts = [], attaches = [];
  return { workspace: fixture(), user: { id: "user" }, deviceId: "host", device: { name: "Desktop", status: "online" },
    devices: [], states: {}, mounted: ["pty-1"], activeId: "pty-1", starting: false, link: "open",
    start: (item) => starts.push(item.id), attach: (id) => attaches.push(id), starts, attaches };
}

test("same-name devices expose installed/development channel and conversation support before switching", () => {
  const content = (node) => node == null || typeof node === "boolean" ? ""
    : typeof node === "object" ? [node.props?.children].flat(Infinity).map(content).join("") : String(node);
  for (const language of ["zh-CN", "en-US"]) {
    const model = modelFixture(), selected = [], t = translator(language);
    model.devices = [
      { id: "release", name: "Desktop", status: "online", platform: "windows", clientKind: "release", capabilities: [] },
      { id: "dev", name: "Desktop", status: "online", platform: "windows", clientKind: "development", capabilities: ["terminal.transcript"] },
    ];
    model.device = model.devices[0]; model.deviceId = "release";
    model.setDeviceId = (id) => selected.push(id);
    const h = renderHarness("Sidebar", model, language);
    assert.ok(h.nodes().some((node) => node.props["aria-label"]?.includes(t("release"))));
    const options = h.nodes().filter((node) => node.props.role === "menuitemradio");
    assert.ok(content(options[0]).includes(t("release")) && content(options[0]).includes(t("terminalOnly")));
    assert.ok(content(options[1]).includes(t("development")) && content(options[1]).includes(t("chatSupported")));
    options[1].props.onClick();
    assert.deepEqual(selected, ["dev"]);
  }
});

test("sidebar renders groups/paths and retains correct starts, session attach and scoped collapse", () => {
  const model = modelFixture();
  const h = renderHarness("Sidebar", model);
  const group = () => h.nodes().find((node) => node.key === "group:dev");
  assert.ok(group());
  const expandedKeys = h.nodes().filter((node) => node.type === "section"
    && node.props.children[0].props.children?.props?.["aria-expanded"] === true).map((node) => node.key);
  // Project rows have both a toggle and start button; inspect their toggle separately.
  const expandedProjects = h.nodes().filter((node) => node.type === "section" && node.key.startsWith("project:")
    && node.props.children[0].props.children[0].props["aria-expanded"]).map((node) => node.key);
  assert.deepEqual(expandedKeys, ["group:dev", "group:nested"]);
  assert.deepEqual(expandedProjects, ["project:first"]);
  const projectSections = h.nodes().filter((node) => node.type === "section" && node.key.startsWith("project:"));
  assert.deepEqual(projectSections.map((node) => node.key), ["project:root", "project:first", "project:second", "project:ssh", "project:orphan"]);
  assert.ok(h.nodes().some((node) => node.type === "small" && node.props.children === "/work/second"));
  const buttons = h.nodes().filter((node) => node.type === "button");
  buttons.find((node) => node.props["aria-current"] === "page").props.onClick();
  assert.deepEqual(model.attaches, ["pty-1"]);
  const starts = buttons.filter((node) => node.props["aria-label"] === "新建会话 · CLI-Manager");
  starts[1].props.onClick();
  assert.deepEqual(model.starts, ["second"]);
  assert.equal(buttons.find((node) => node.props["aria-label"] === "新建会话 · SSH").props.disabled, true);
  group().props.children[0].props.children.props.onClick();
  h.render();
  assert.equal(h.nodes().some((node) => node.key === "project:first"), false);
  h.nodes().find((node) => node.type === "input").props.onChange({ target: { value: "CLI-Manager" } });
  h.render();
  assert.equal(h.nodes().filter((node) => node.type === "section" && node.key.startsWith("project:")).length, 2);
  h.nodes().find((node) => node.type === "input").props.onChange({ target: { value: "" } });
  model.deviceId = "another-host";
  h.render();
  assert.equal(h.nodes().some((node) => node.key === "project:first"), true);
  model.device.status = "offline";
  h.render();
  assert.ok(h.nodes().filter((node) => node.props["aria-label"]?.startsWith("新建会话")).every((node) => node.props.disabled));
});

test("sidebar starts collapsed without live terminals and follows delayed status/snapshot arrivals", () => {
  const model = modelFixture();
  model.activeId = undefined;
  model.states = { "pty-1": { status: "exited" } };
  const h = renderHarness("Sidebar", model);
  const toggles = () => h.nodes().filter((node) => node.props.className === "tap-folder-toggle");
  assert.ok(toggles().every((node) => !node.props["aria-expanded"]));
  model.states = {};
  h.render();
  assert.equal(toggles().filter((node) => node.props["aria-expanded"]).length, 3);
  model.workspace = { ...model.workspace, terminals: [...model.workspace.terminals,
    { sessionId: "pty-2", projectId: "root", worktreeId: null, title: "Root terminal" }] };
  h.render();
  assert.equal(toggles().filter((node) => node.props["aria-expanded"]).length, 4);
  model.states = { "pty-1": { status: "closed" }, "pty-2": { status: "exited" } };
  h.render();
  assert.ok(toggles().every((node) => !node.props["aria-expanded"]));
  model.activeId = "pty-1";
  h.render();
  assert.equal(toggles().filter((node) => node.props["aria-expanded"]).length, 3, "the viewed session remains reachable");
});

test("picker shares tree order, preserves worktree ID, and renders both locales", () => {
  for (const language of ["zh-CN", "en-US"]) {
    const model = modelFixture();
    const h = renderHarness("NewSession", model, language);
    assert.ok(h.nodes().some((node) => node.key === "group:nested"));
    const cards = h.nodes().filter((node) => node.props.className === "tap-card");
    assert.deepEqual(cards.map((node) => node.key), ["project:root", "project:first", "project:second", "project:ssh", "project:orphan"]);
    h.nodes().find((node) => node.key === "wt").props.onClick();
    assert.equal(h.starts[0][0].id, "first");
    assert.equal(h.starts[0][1], "wt");
    assert.equal(h.closes, 1);
    assert.ok(h.nodes().some((node) => node.props.children === translator(language)("emptyGroup")));
  }
});
