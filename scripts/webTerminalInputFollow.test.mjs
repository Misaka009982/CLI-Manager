import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../apps/web/src/terminalCursorView.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { createTerminalInputFollow, revealTerminalCell } = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);

test("opening/selecting a model keeps horizontal scroll fixed despite a far-right paint cursor", () => {
  const follow = createTerminalInputFollow();
  let scrollLeft = 0;
  const parsed = (time, cursorVisible, cursorX) => {
    if (follow.canReveal(time, cursorVisible)) scrollLeft = revealTerminalCell(scrollLeft, 400, cursorX, 10);
  };
  follow.input("/model", 100);
  parsed(110, true, 90);
  follow.input("\r", 120);
  parsed(125, true, 1200);
  parsed(130, false, 1600);
  follow.input("\x1b[B", 150);
  parsed(160, true, 1200);
  follow.input("\r", 170);
  parsed(180, true, 1500);
  parsed(190, true, 25);
  assert.equal(scrollLeft, 0);
});

test("Unicode edits and one-line paste still reveal the input caret", () => {
  for (const data of ["a", "中文", "🙂", "\x7f", "\b", "\x1b[200~中文/path\x1b[201~"]) {
    const follow = createTerminalInputFollow();
    follow.input(data, 100);
    assert.equal(follow.canReveal(110, true), true, JSON.stringify(data));
    assert.equal(revealTerminalCell(0, 400, 510, 10), 120);
    assert.equal(follow.canReveal(110, false), false, "hidden repaint cursor must not move viewport");
  }
});

test("control/navigation input cancels an already pending text follow", () => {
  for (const data of ["", "\r", "\n", "\t", "\x1b", "\x1b[A", "\x1b[C", "\x1bOD", "\x03", "\x1b[<0;120;30M",
    "\x1b[200~line1\nline2\x1b[201~", "line\rnext"]) {
    const follow = createTerminalInputFollow();
    follow.input("text", 100);
    assert.equal(follow.canReveal(110, true), true);
    follow.input(data, 120);
    assert.equal(follow.canReveal(130, true), false, JSON.stringify(data));
  }
});

test("hidden caret, manual navigation, tab lifecycle and elapsed time cannot revive following", () => {
  const follow = createTerminalInputFollow();
  assert.equal(follow.canReveal(0, true), false);
  follow.input("text", 100);
  assert.equal(follow.canReveal(120, false), false);
  assert.equal(follow.canReveal(180, true), true);
  follow.cancel();
  assert.equal(follow.canReveal(200, true), false);
  follow.input("next", 300);
  assert.equal(follow.canReveal(1801, true), false);
  assert.equal(createTerminalInputFollow().canReveal(310, true), false);
});
