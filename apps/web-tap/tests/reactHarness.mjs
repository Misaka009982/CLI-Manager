import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const React = require("react");

/** Execute production modules with explicit I/O substitutes; no desktop app or browser server. */
export function loadModule(file, dependencies = {}, globals = {}, expose = []) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const code = ts.transpileModule(`${source}\n${expose.map((name) => `export { ${name} };`).join("\n")}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, setTimeout, clearTimeout, AbortController, DOMException,
    require: (id) => {
      if (id in dependencies) return dependencies[id];
      assert.ok(!id.startsWith("."), `Mock local dependency ${id} for ${file}`);
      return require(id);
    }, ...globals,
  }, { filename: file });
  return exports;
}

/** Minimal hook lifecycle, including dependency cleanup and state changes during effects. */
export function hookHarness() {
  const slots = [];
  let cursor = 0, dirty = false, renderBody, value;
  let effects = [];
  const equal = (left, right) => left && right && left.length === right.length && left.every((item, i) => Object.is(item, right[i]));
  const memo = (create, deps) => {
    const index = cursor++;
    if (!slots[index] || !equal(slots[index].deps, deps)) slots[index] = { deps, value: create() };
    return slots[index].value;
  };
  const effect = (run, deps) => {
    const index = cursor++;
    const old = slots[index];
    if (old && equal(old.deps, deps)) return;
    const next = { deps, cleanup: old?.cleanup };
    slots[index] = next;
    effects.push(() => { next.cleanup?.(); next.cleanup = run(); });
  };
  const react = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (next) => {
        const value = typeof next === "function" ? next(slots[index].value) : next;
        if (!Object.is(slots[index].value, value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useRef: (initial) => memo(() => ({ current: initial }), []),
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useEffect: effect,
    useLayoutEffect: effect,
    useId: () => memo(() => `test-${cursor}`, []),
  };
  const render = () => {
    let iterations = 0;
    do {
      assert.ok(iterations++ < 30, "render must settle");
      dirty = false; cursor = 0;
      value = renderBody();
      const pending = effects; effects = [];
      pending.forEach((run) => run());
    } while (dirty);
    return value;
  };
  return {
    react,
    mount(body) { renderBody = body; return render(); },
    render,
    get value() { return value; },
    async settle() { for (let i = 0; i < 12; i++) { await Promise.resolve(); if (dirty) render(); } return value; },
    dispose() { slots.forEach((slot) => slot.cleanup?.()); },
  };
}

export const nodes = (node) => !node || typeof node !== "object" ? []
  : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
export const textContent = (node) => node == null || typeof node === "boolean" ? ""
  : typeof node === "object" ? [node.props?.children].flat(Infinity).map(textContent).join("") : String(node);
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
