import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function createLayout({ width = 248, viewport = 1200, dockSide = "left", compactMode = false, mac = false } = {}) {
  const events = () => {
    const listeners = new Map();
    return {
      addEventListener(name, handler) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(handler);
      },
      removeEventListener(name, handler) { listeners.get(name)?.delete(handler); },
      dispatch(name, event = {}) {
        for (const handler of [...(listeners.get(name) ?? [])]) handler(event);
      },
    };
  };
  const window = { ...events(), innerWidth: viewport };
  const document = { ...events(), body: { style: {} } };
  const frames = new Map();
  let frameId = 0;
  const slots = [];
  let cursor = 0;
  let pendingEffects = [];
  const persisted = [];
  const notifications = [];
  const settings = { sidebarWidth: width, update: (key, value) => persisted.push([key, value]) };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value) => { slots[index] = value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        slots[index] = { value: callback, deps };
      }
      return slots[index].value;
    },
    useEffect(callback, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        slots[index] = { deps };
        pendingEffects.push(() => {
          previous?.cleanup?.();
          slots[index].cleanup = callback();
        });
      }
    },
  };
  const common = {
    window, document, navigator: { platform: mac ? "MacIntel" : "Win32" },
    requestAnimationFrame: (callback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  function load(path, require) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports = {};
    vm.runInNewContext(output, { ...common, exports, require });
    return exports;
  }
  const model = load("../src/features/projects/lib/sidebarModel.ts", () => ({}));
  const commands = {
    SIDEBAR_EXPAND_REQUEST_EVENT: "expand",
    SIDEBAR_TOGGLE_REQUEST_EVENT: "toggle",
    notifySidebarStateChange: (state) => notifications.push(state),
  };
  const { useSidebarLayout } = load("../src/features/projects/hooks/useSidebarLayout.ts", (name) => {
    if (name === "react") return react;
    if (name.endsWith("/sidebarModel")) return model;
    if (name.endsWith("/sidebarCommands")) return commands;
    if (name.endsWith("/settingsStore")) return { useSettingsStore: (select) => select(settings) };
    if (name.endsWith("/shell")) return { getOsPlatform: async () => mac ? "macos" : "windows" };
    throw new Error("Unexpected dependency: " + name);
  });
  function render() {
    cursor = 0;
    const value = useSidebarLayout({ compactMode, dockSide });
    const effects = pendingEffects;
    pendingEffects = [];
    effects.forEach((effect) => effect());
    return value;
  }
  render();
  return {
    render, window, document, persisted, settings, notifications,
    flush() {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback());
    },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

test("sidebar width normalizes legacy settings and explicit collapse/expand persists", () => {
  const app = createLayout({ width: 280 });
  assert.equal(app.render().sidebarWidth, 248);
  app.render().toggleSidebarCollapsed();
  assert.equal(app.render().sidebarWidth, 64);
  assert.equal(app.render().sidebarCollapsed, true);
  app.window.dispatch("expand");
  assert.equal(app.render().sidebarWidth, 248);
  assert.deepEqual(app.persisted, [["sidebarWidth", 64], ["sidebarWidth", 248]]);
  app.window.dispatch("toggle");
  assert.equal(app.render().sidebarCollapsed, true);
  app.unmount();
});

for (const dockSide of ["left", "right"]) {
  test(dockSide + " docking previews drag per frame and persists only on release", () => {
    const app = createLayout({ dockSide });
    const layout = app.render();
    const element = { style: {} };
    layout.sidebarElementRef.current = element;
    const x = (width) => dockSide === "right" ? 1200 - width : width;
    layout.startResize({ preventDefault() {}, clientX: x(248) });
    app.document.dispatch("mousemove", { clientX: x(330) });
    app.document.dispatch("mousemove", { clientX: x(390) });
    assert.equal(app.persisted.length, 0);
    app.flush();
    assert.equal(element.style.width, "390px");
    assert.equal(app.render().sidebarWidth, 248);
    app.document.dispatch("mouseup");
    assert.equal(app.render().sidebarWidth, 390);
    assert.equal(app.render().sidebarResizing, false);
    assert.equal(app.document.body.style.cursor, "");
    assert.deepEqual(app.persisted, [["sidebarWidth", 390]]);
    app.unmount();
  });
}

test("viewport collapse restores expanded width without persisting automatic changes", () => {
  const app = createLayout({ width: 320 });
  app.window.innerWidth = 800;
  app.window.dispatch("resize");
  assert.equal(app.render().sidebarCollapsed, true);
  app.window.innerWidth = 1200;
  app.window.dispatch("resize");
  assert.equal(app.render().sidebarWidth, 320);
  assert.deepEqual(app.persisted, []);
  app.settings.sidebarWidth = 400;
  app.render();
  assert.equal(app.render().sidebarWidth, 400);
  app.unmount();
});

test("compact and macOS layouts do not automatically collapse in narrow viewports", () => {
  for (const options of [{ compactMode: true }, { mac: true }]) {
    const app = createLayout({ viewport: 700, ...options });
    assert.equal(app.render().sidebarCollapsed, false);
    app.window.dispatch("resize");
    assert.equal(app.render().sidebarCollapsed, false);
    app.unmount();
  }
});
