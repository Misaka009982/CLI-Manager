import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// 执行真实 Hook/组件回调，模拟 React 的持久槽位、依赖比较及 effect 清理；不启动桌面服务。
function harness(file, name, dependencies = {}) {
  const slots = [], effects = [];
  let cursor = 0, dirty = false, props, output;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const memo = (factory, deps) => {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { value: factory(), deps };
    return slots[index].value;
  };
  const effect = (callback, deps) => {
    const index = cursor++;
    const previous = slots[index];
    if (previous && same(previous.deps, deps)) return;
    slots[index] = { deps, cleanup: previous?.cleanup };
    effects.push(() => {
      slots[index].cleanup?.();
      slots[index].cleanup = callback();
    });
  };
  const sourceText = readFileSync(new URL(file, import.meta.url), "utf8");
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText()).join("\n");
  const compiled = ts.transpileModule(`${body}\nexports.testTarget = ${name};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: "createElement" },
  }).outputText;
  const exports = {};
  runInNewContext(compiled, {
    exports,
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useState: initial => {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      const slot = slots[index];
      slot.set ??= next => {
        const value = typeof next === "function" ? next(slot.value) : next;
        if (!Object.is(value, slot.value)) { slot.value = value; dirty = true; }
      };
      return [slot.value, slot.set];
    },
    useRef: initial => {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    },
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useEffect: effect,
    useLayoutEffect: effect,
    HTMLElement: FakeElement,
    ...dependencies,
  });
  return {
    get output() { return output; },
    render(nextProps = props) {
      props = nextProps;
      for (let pass = 0; pass < 30; pass += 1) {
        cursor = 0;
        dirty = false;
        output = exports.testTarget(props);
        while (effects.length) effects.shift()();
        if (!dirty) return output;
      }
      throw new Error("unbounded render loop");
    },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
  };
}

class FakeElement {
  constructor(clientHeight = 200, scrollHeight = 1000) {
    this.clientHeight = clientHeight;
    this.scrollHeight = scrollHeight;
    this.position = 0;
    this.listeners = new Map();
    this.style = {};
    this.captures = new Set();
  }
  get scrollTop() { return this.position; }
  set scrollTop(value) { this.position = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, value)); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
  dispatch(name, values = {}) { this.listeners.get(name)?.(values); }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  focus() { this.focused = true; }
  scrollIntoView() { this.revealed = true; }
  getAttribute(name) { return name === "role" ? this.role : null; }
  contains(node) { return node === this.option; }
  querySelector() { return this.option; }
}

function observers() {
  const instances = [];
  return {
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.elements = new Set(); instances.push(this); }
      observe(element) { this.elements.add(element); }
      disconnect() { this.elements.clear(); }
    },
    resize(element) { for (const instance of instances) if (instance.elements.has(element)) instance.callback(); },
    observed(element) { return instances.some(instance => instance.elements.has(element)); },
  };
}

function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of node.props?.children ?? []) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}
const element = (tree, type) => find(tree, node => node.type === type);
const action = (tree, key) => find(tree, node => node.props?.["aria-label"] === `terminal.markdownPreview.${key}`);
const settle = () => new Promise(resolve => setImmediate(resolve));
const event = (currentTarget, values = {}) => ({
  currentTarget, target: currentTarget, button: 0, pointerId: 1, clientY: 0,
  preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...values,
});

function scrollFixture() {
  const observer = observers();
  const h = harness("../src/features/terminal/hooks/useMarkdownPreviewScroll.ts", "useMarkdownPreviewScroll", observer);
  const props = { open: true, sessionKey: "a", selectedMessageIndex: 2, content: "old answer" };
  const viewport = new FakeElement(), content = new FakeElement();
  const api = h.render(props);
  api.scrollRef(viewport);
  api.contentRef(content);
  h.render();
  return { h, props, viewport, content, observer };
}

test("body jump is local, repeatable, and tracks late rendering only until the user scrolls", () => {
  const a = scrollFixture(), b = scrollFixture();
  assert.equal(a.h.output.showScrollToBottom, true);
  a.h.output.scrollToBottom(); a.h.render();
  assert.equal(a.viewport.scrollTop, 800);
  assert.equal(a.props.selectedMessageIndex, 2);
  assert.equal(a.h.output.showScrollToBottom, false);
  assert.equal(b.viewport.scrollTop, 0);
  a.viewport.scrollHeight = 1400;
  a.observer.resize(a.content); a.h.render();
  assert.equal(a.viewport.scrollTop, 1200, "late Markdown/image height remains at the explicit target");
  a.viewport.dispatch("wheel");
  a.viewport.scrollTop = 100;
  a.viewport.dispatch("scroll");
  a.viewport.scrollHeight = 1600;
  a.observer.resize(a.content); a.h.render();
  assert.equal(a.viewport.scrollTop, 100, "user reading position is not overridden");
  assert.equal(a.h.output.showScrollToBottom, true);
  a.h.output.scrollToBottom(); a.h.render();
  assert.equal(a.viewport.scrollTop, 1400);
});

test("latest-answer jump waits for the selected content commit and cancels stale session intents", () => {
  const f = scrollFixture();
  f.h.output.requestScrollToBottom(17); f.h.render();
  assert.equal(f.viewport.scrollTop, 0);
  f.props.selectedMessageIndex = 17;
  f.props.content = "latest answer";
  f.h.render();
  assert.equal(f.viewport.scrollTop, 800);
  f.h.output.requestScrollToBottom(22);
  f.props.sessionKey = "b";
  f.props.selectedMessageIndex = 22;
  f.props.content = "other session";
  f.viewport.scrollTop = 0;
  f.h.render();
  assert.equal(f.viewport.scrollTop, 0);
  f.h.output.requestScrollToBottom(30);
  f.h.output.cancelScrollIntent();
  f.props.selectedMessageIndex = 30;
  f.h.render();
  assert.equal(f.viewport.scrollTop, 0);
});

test("empty, resized, refreshed, and closed previews do not leave stale controls or observers", () => {
  const f = scrollFixture();
  f.h.output.scrollToBottom(); f.h.render();
  f.props.content = "a refreshed answer";
  f.viewport.scrollHeight = 1600;
  f.h.render(); f.observer.resize(f.content); f.h.render();
  assert.equal(f.viewport.scrollTop, 800, "new content does not enable automatic following");
  f.viewport.clientHeight = 2000;
  f.observer.resize(f.viewport); f.h.render();
  assert.equal(f.h.output.showScrollToBottom, false);
  f.props.content = null;
  f.h.render();
  assert.equal(f.h.output.showScrollToBottom, false);
  f.props.open = false;
  f.h.render();
  assert.equal(f.observer.observed(f.viewport), false);
  assert.equal(f.viewport.listeners.size, 0);
  f.h.unmount();
});

test("answer list jump preserves selection and menu state and its fixed action is keyboard reachable", () => {
  const selected = [];
  const primitives = Object.fromEntries(["Root", "Trigger", "Value", "Icon", "Portal", "Content", "Viewport", "Item", "ItemText", "ItemIndicator"].map(key => [key, key]));
  const h = harness("../src/features/terminal/components/MarkdownPreviewAnswerSelect.tsx", "MarkdownPreviewAnswerSelect", {
    SelectPrimitive: primitives, ArrowDownToLine: "Icon", Check: "Check", ChevronDown: "ChevronDown",
  });
  const messages = [{ messageIndex: 4 }, { messageIndex: 19 }];
  const props = { messages, selectedMessageIndex: 4, onSelect: value => selected.push(value), formatOption: message => String(message.messageIndex) };
  h.render(props);
  const viewport = new FakeElement(), button = new FakeElement(), option = new FakeElement();
  option.role = "option"; viewport.option = option;
  element(h.output, "Viewport").props.ref(viewport);
  element(h.output, "button").props.ref.current = button;
  h.render();
  element(h.output, "button").props.onClick();
  assert.equal(viewport.scrollTop, 800);
  assert.deepEqual(selected, []);
  assert.equal(h.output.props.value, "4");
  assert.equal(h.output.props.open, undefined, "jump does not take over or close Radix's open state");
  const popup = element(h.output, "Content");
  const tab = event(option, { key: "Tab" });
  popup.props.onKeyDown(tab);
  assert.equal(tab.prevented, true);
  assert.equal(button.focused, true);
  popup.props.onKeyDown(event(button, { key: "Tab", shiftKey: true }));
  assert.equal(option.focused, true);
  const space = event(button, { key: " " });
  element(h.output, "button").props.onKeyDown(space);
  assert.equal(space.stopped, true);
  assert.equal(space.prevented, undefined, "native keyboard button activation is retained");
  h.output.props.onValueChange("19");
  assert.deepEqual(selected, [19]);
});

test("overlay thumb follows viewport geometry, drag bounds, pointer cancellation, and cleanup", () => {
  const observer = observers(), viewport = new FakeElement(), content = new FakeElement();
  const h = harness("../src/features/terminal/components/MarkdownPreviewAnswerSelect.tsx", "AnswerScrollbar", observer);
  h.render({ viewport: null, content });
  const track = new FakeElement(100, 100), thumb = new FakeElement();
  h.output.props.ref.current = track;
  h.output.props.children[0].props.ref.current = thumb;
  h.render({ viewport, content });
  assert.equal(h.output.props["data-visible"], "true");
  assert.equal(thumb.style.height, "24px");
  let handlers = h.output.props.children[0].props;
  handlers.onPointerDown(event(thumb)); h.render();
  handlers = h.output.props.children[0].props;
  handlers.onPointerMove(event(thumb, { clientY: 76 }));
  viewport.dispatch("scroll");
  assert.equal(viewport.scrollTop, 800);
  assert.equal(thumb.style.transform, "translateY(76px)");
  handlers.onPointerMove(event(thumb, { clientY: 1000 }));
  assert.equal(viewport.scrollTop, 800);
  handlers.onPointerMove(event(thumb, { pointerId: 2, clientY: -100 }));
  assert.equal(viewport.scrollTop, 800, "another pointer cannot take over the drag");
  handlers.onPointerCancel(event(thumb)); h.render();
  assert.equal(h.output.props["data-dragging"], "false");
  assert.equal(thumb.captures.size, 0);
  viewport.scrollHeight = 100;
  observer.resize(content); h.render();
  assert.equal(h.output.props.style.visibility, "hidden");
  h.unmount();
  assert.equal(observer.observed(viewport), false);
  assert.equal(viewport.listeners.size, 0);
});

function previewFixture(overrides = {}) {
  const requests = [], jumps = [], closes = [];
  const terminal = { sessions: [{ id: "view", cliSessionId: "a", cliTool: "codex", cwd: "project" }], tabStatuses: {} };
  const projects = { projects: [] }, worktrees = { worktrees: [] };
  overrides.setup?.({ terminal, projects });
  const previewScroll = { requestScrollToBottom: id => jumps.push(id), cancelScrollIntent() {} };
  const h = harness("../src/features/terminal/components/TerminalMarkdownPreview.tsx", "TerminalMarkdownPreview", {
    useI18n: () => ({ language: "en-US", t: key => key }),
    useTerminalPreviewTheme: () => ({ tone: "dark", panelStyle: {} }),
    useSettingsStore: selector => selector({ uiFontFamily: "mono", uiFontSize: 14 }),
    useTerminalStore: selector => selector(terminal),
    useProjectStore: selector => selector(projects),
    useWorktreeStore: selector => selector(worktrees),
    useMarkdownPreviewScroll: () => previewScroll,
    useFontSizeControlVisibility: () => ({ fontSizeControlVisible: false, showFontSizeControl() {} }),
    normalizeFontFamilyStack: value => value,
    resolveCliToolHistorySourceId: value => value || null,
    resolveTerminalProjectPath: value => value,
    unwrapFencedMarkdown: value => value,
    fetchLatestProjectSessionDetail: (...args) => new Promise(resolve => requests.push({ args, resolve })),
    invoke: (command, args) => { closes.push({ command, args }); return Promise.resolve(); },
    ArrowDown: "ArrowDown", ArrowDownToLine: "ArrowDownToLine", FileText: "FileText", RefreshCw: "RefreshCw", X: "X",
    SessionTranscriptContent: "Transcript", MarkdownPreviewAnswerSelect: "AnswerSelect", FontSizeControl: "FontSize",
    ...overrides.dependencies,
  });
  h.render({ sessionId: "view", open: true, onClose() {} });
  return { h, terminal, requests, jumps, closes };
}

test("latest action selects the actual final message index while background refresh preserves older selection", async () => {
  const f = previewFixture();
  const messages = [
    { role: "user", content: "question" }, { role: "assistant", content: "first" },
    { role: "tool", content: "result" }, { role: "assistant", content: "last" },
  ];
  f.requests[0].resolve({ messages }); await settle(); f.h.render();
  element(f.h.output, "AnswerSelect").props.onSelect(1); f.h.render();
  action(f.h.output, "refresh").props.onClick();
  f.requests[1].resolve({ messages: [...messages, { role: "assistant", content: "new last" }] });
  await settle(); f.h.render();
  assert.equal(element(f.h.output, "AnswerSelect").props.selectedMessageIndex, 1);
  action(f.h.output, "latestAnswer").props.onClick(); f.h.render();
  assert.equal(element(f.h.output, "AnswerSelect").props.selectedMessageIndex, 4);
  assert.deepEqual(f.jumps, [4]);
  action(f.h.output, "latestAnswer").props.onClick(); f.h.render();
  assert.deepEqual(f.jumps, [4, 4]);
});

test("late history responses cannot overwrite a newly bound terminal session", async () => {
  const f = previewFixture();
  f.terminal.sessions[0] = { ...f.terminal.sessions[0], cliSessionId: "b" };
  f.h.render();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve({ messages: [{ role: "assistant", content: "session b" }] });
  await settle(); f.h.render();
  f.requests[0].resolve({ messages: [{ role: "assistant", content: "stale session a" }] });
  await settle(); f.h.render();
  assert.equal(element(f.h.output, "Transcript").props.content, "session b");
  f.h.unmount();
});

test("a superseded SSH context is closed before any transcript read and cannot replace the new consumer", async () => {
  const builds = [], reads = [];
  const f = previewFixture({
    setup({ terminal, projects }) {
      terminal.sessions[0].projectId = "remote";
      projects.projects = [{ id: "remote", environment_type: "ssh", remote_path: "/project" }];
    },
    dependencies: {
      buildSshAgentHistoryContext: () => new Promise(resolve => builds.push(resolve)),
      fetchRemoteLatestProjectSessionDetail: async context => {
        reads.push(context.consumerId);
        return { context, result: { messages: [{ role: "assistant", content: context.consumerId }] } };
      },
    },
  });
  f.terminal.sessions[0] = { ...f.terminal.sessions[0], cliSessionId: "b" };
  f.h.render();
  const context = consumerId => ({ consumerId, hostId: "host", launch: { projectId: "remote" } });
  builds[0](context("old-consumer")); await settle(); f.h.render();
  assert.deepEqual(reads, []);
  assert.equal(f.closes[0].args.consumerId, "old-consumer");
  builds[1](context("new-consumer")); await settle(); f.h.render();
  assert.deepEqual(reads, ["new-consumer"]);
  assert.equal(element(f.h.output, "Transcript").props.content, "new-consumer");
  f.h.unmount();
  assert.equal(f.closes.at(-1).args.consumerId, "new-consumer");
});
