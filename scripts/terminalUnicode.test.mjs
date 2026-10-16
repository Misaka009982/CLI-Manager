import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/xterm");
const { SerializeAddon } = require("@xterm/addon-serialize");
const source = readFileSync(new URL("../src/shared/lib/terminalUnicode.ts", import.meta.url), "utf8");

// 替换构建期环境变量，运行实际模块与真实 xterm/addon，不模拟字符宽度服务。
function loadUnicodeModule(buildMode) {
  const compiled = ts.transpileModule(
    source.replace("import.meta.env?.VITE_TERMINAL_UNICODE_MODE", JSON.stringify(buildMode) ?? "undefined"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const exports = {};
  new Function("require", "exports", compiled)(require, exports);
  return exports;
}

const { installTerminalUnicode } = loadUnicodeModule();
const samples = [
  ["✅", 2], ["❌", 2], ["⚠️", 2], ["⚠", 1], ["✔", 1],
  ["👨‍👩‍👧‍👦", 2], ["🇨🇳", 2], ["👍🏽", 2], ["中文", 4], ["e\u0301", 1],
];
const write = (terminal, data) => new Promise((resolve) => terminal.write(data, resolve));

// 所有测试终端单独持有 provider，结束时覆盖真实 addon 清理路径。
function createTerminal(t, options = {}, install = installTerminalUnicode) {
  const terminal = new Terminal({ cols: 32, rows: 12, allowProposedApi: true, ...options });
  install(terminal);
  t.after(() => terminal.dispose());
  return terminal;
}

// 同时比较字符、占格和光标，避免只检查 translateToString 而漏掉列漂移。
function snapshot(terminal) {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    lines.push(Array.from({ length: terminal.cols }, (_, x) => {
      const cell = line.getCell(x);
      return [cell.getChars(), cell.getWidth(), cell.getFgColor(), cell.isBold()];
    }));
  }
  return { lines, cursorX: buffer.cursorX, cursorY: buffer.cursorY, baseY: buffer.baseY };
}

test("default grapheme widths align CLI table borders for emoji, CJK and combining marks", async (t) => {
  const terminal = createTerminal(t);
  assert.equal(terminal.unicode.activeVersion, "15-graphemes");
  for (const [text, width] of samples) {
    await write(terminal, `\r\x1b[2K│${text}${" ".repeat(6 - width)}│`);
    const line = terminal.buffer.active.getLine(terminal.buffer.active.cursorY);
    assert.equal(line.getCell(7).getChars(), "│", text);
    assert.equal(terminal.buffer.active.cursorX, 8, text);
    assert.equal(line.translateToString(true), `│${text}${" ".repeat(6 - width)}│`);
  }
});

test("streamed UTF-8 bytes and separate Unicode writes match a complete ANSI transcript", async (t) => {
  const content = samples.map(([text, width]) => `│\x1b[1;32m${text}\x1b[0m${" ".repeat(6 - width)}│`).join("\r\n");
  const complete = createTerminal(t, { cols: 9 });
  await write(complete, content);
  for (const chunks of [Array.from(content), Array.from(new TextEncoder().encode(content), (byte) => Uint8Array.of(byte))]) {
    const streamed = createTerminal(t, { cols: 9 });
    for (const chunk of chunks) await write(streamed, chunk);
    assert.deepEqual(snapshot(streamed), snapshot(complete));
  }
});

test("graphemes wrap at the final column and report the correct cursor position", async (t) => {
  const terminal = createTerminal(t, { cols: 8, rows: 4 });
  await write(terminal, "1234567⚠️X");
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), "1234567");
  assert.equal(terminal.buffer.active.getLine(1).getCell(0).getChars(), "⚠️");
  assert.equal(terminal.buffer.active.getLine(1).getCell(0).getWidth(), 2);
  assert.equal(terminal.buffer.active.getLine(1).getCell(2).getChars(), "X");
  const replies = [];
  terminal.onData((data) => replies.push(data));
  await write(terminal, "\x1b[6n");
  assert.deepEqual(replies, ["\x1b[2;4R"]);
});

test("reset and alternate-screen transitions retain the selected provider", async (t) => {
  const terminal = createTerminal(t);
  await write(terminal, "normal⚠️");
  await write(terminal, "\x1b[?1049h\x1b[H👨‍👩‍👧‍👦|");
  assert.equal(terminal.buffer.active.type, "alternate");
  assert.equal(terminal.buffer.active.cursorX, 3);
  await write(terminal, "\x1b[?1049l");
  assert.equal(terminal.buffer.active.type, "normal");
  assert.equal(terminal.buffer.active.cursorX, 8);
  await write(terminal, "\x1bc👍🏽|");
  assert.equal(terminal.unicode.activeVersion, "15-graphemes");
  assert.equal(terminal.buffer.active.cursorX, 3);
  terminal.reset();
  await write(terminal, "⚠️|");
  assert.equal(terminal.buffer.active.cursorX, 3);
});

test("late variation selectors and ZWJ continuations wrap identically across writes", async (t) => {
  for (const emoji of ["⚠️", "👨‍👩‍👧‍👦", "👍🏽"]) {
    const content = `1234567${emoji}X`;
    const complete = createTerminal(t, { cols: 8, rows: 5 });
    const streamed = createTerminal(t, { cols: 8, rows: 5 });
    await write(complete, content);
    for (const part of content) await write(streamed, part);
    assert.deepEqual(snapshot(streamed), snapshot(complete), emoji);
  }
});

test("serialize/replay and split-pane resizing preserve grapheme cells and styles", async (t) => {
  const terminal = createTerminal(t, { cols: 16, rows: 8 });
  const serialize = new SerializeAddon();
  terminal.loadAddon(serialize);
  await write(terminal, "\x1b[32mA⚠️👨‍👩‍👧‍👦👍🏽🇨🇳中\x1b[0m\r\nend✅");
  const restored = createTerminal(t, { cols: 16, rows: 8 });
  await write(restored, serialize.serialize());
  assert.deepEqual(snapshot(restored), snapshot(terminal));
  for (const cols of [8, 24, 16]) {
    terminal.resize(cols, 8);
    restored.resize(cols, 8);
    assert.deepEqual(snapshot(restored), snapshot(terminal));
    assert.equal(restored.unicode.activeVersion, "15-graphemes");
  }
});

test("build-time Unicode 11 rollback is explicit and does not leak across terminals", async (t) => {
  const compatibility = loadUnicodeModule("unicode11");
  assert.equal(compatibility.TERMINAL_UNICODE_MODE, "unicode11");
  const legacy = createTerminal(t, {}, compatibility.installTerminalUnicode);
  const modern = createTerminal(t);
  await write(legacy, "⚠️👨‍👩‍👧‍👦👍🏽|");
  await write(modern, "⚠️👨‍👩‍👧‍👦👍🏽|");
  assert.equal(legacy.unicode.activeVersion, "11");
  assert.equal(legacy.buffer.active.cursorX, 14);
  assert.equal(modern.buffer.active.cursorX, 7);
  assert.equal(loadUnicodeModule("unknown").TERMINAL_UNICODE_MODE, "graphemes");
});

test("desktop and Web install the shared provider before opening their terminal", () => {
  for (const path of ["../src/features/terminal/hooks/useXTermController.ts", "../apps/web/src/WebTerminal.tsx"]) {
    const code = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(code, /allowProposedApi: true/);
    assert.ok(code.indexOf("installTerminalUnicode(terminal)") < code.indexOf("terminal.open("), path);
    assert.equal((code.match(/installTerminalUnicode\(terminal\)/g) ?? []).length, 1);
    assert.doesNotMatch(code, /new Unicode11Addon|unicode\.activeVersion\s*=/);
  }
});
