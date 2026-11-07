import assert from "node:assert/strict";
import { test } from "node:test";
import { keyBytes, composerAction, preparePaste } from "./input.ts";

const plain = { ctrl: false, alt: false };
test("keys preserve native menu and application cursor sequences", () => {
  assert.equal(keyBytes("backtab", plain), "\x1b[Z");
  assert.equal(keyBytes("up", plain, true), "\x1bOA");
  assert.equal(keyBytes("down", { ctrl: true, alt: true }), "\x1b[1;7B");
  assert.equal(keyBytes("enter", { ctrl: false, alt: true }), "\x1b\r");
});
test("Chinese candidate confirmation never sends, even with a send modifier", () => {
  assert.equal(composerAction({ key: "Enter", ctrlKey: true, isComposing: true }, false), "none");
  assert.equal(composerAction({ key: "Enter", keyCode: 229 }, false), "none");
  assert.equal(composerAction({ key: "Enter" }, true), "newline");
  assert.equal(composerAction({ key: "Enter" }, false), "send");
  assert.equal(composerAction({ key: "Enter", metaKey: true }, true), "send");
});
test("paste strips injected boundary markers and refuses unbracketed multiline commands", () => {
  assert.equal(preparePaste("hello\x1b[201~oops", true), "\x1b[200~hellooops\x1b[201~");
  assert.throws(() => preparePaste("one\ntwo", false), /multiline/);
  assert.equal(preparePaste("hello", false), "hello");
});
