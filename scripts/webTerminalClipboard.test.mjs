import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../apps/web/src/terminalClipboard.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { clipboardImageToUpload, isClipboardCopyShortcut, isClipboardPasteShortcut } = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);
const key = (name, overrides = {}) => ({ type: "keydown", key: name, ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, ...overrides });

test("Ctrl+V leaves native paste to the browser; other key combos keep PTY behavior", () => {
  assert.equal(isClipboardPasteShortcut(key("v")), true);
  assert.equal(isClipboardPasteShortcut(key("V")), true);
  for (const event of [key("v", { type: "keyup" }), key("v", { shiftKey: true }), key("v", { altKey: true }), key("v", { ctrlKey: false }), key("c")]) {
    assert.equal(isClipboardPasteShortcut(event), false);
  }
});

test("Ctrl+C copies only with a selection; otherwise the PTY receives an interrupt", () => {
  assert.equal(isClipboardCopyShortcut(key("c"), true), true);
  assert.equal(isClipboardCopyShortcut(key("c"), false), false);
  assert.equal(isClipboardCopyShortcut(key("c", { shiftKey: true }), true), false);
  assert.equal(isClipboardCopyShortcut(key("c", { type: "keyup" }), true), false);
});

test("plain text passes through to xterm; image clipboard retains image priority", () => {
  const image = { type: "image/png" };
  const clipboard = (text, files) => ({ getData: (format) => format === "text/plain" ? text : "", files });
  assert.equal(clipboardImageToUpload(clipboard("text", [])), undefined);
  assert.equal(clipboardImageToUpload(clipboard("text", [image])), image);
  assert.equal(clipboardImageToUpload(clipboard("", [image])), image);
  assert.equal(clipboardImageToUpload(clipboard("", [{ type: "text/plain" }])), undefined);
  assert.equal(clipboardImageToUpload(null), undefined);
});
