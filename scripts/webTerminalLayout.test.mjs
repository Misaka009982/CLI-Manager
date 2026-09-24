import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText)}`;
const displayUrl = moduleUrl(read("../apps/web/src/terminalDisplay.ts"));
const { DEFAULT_DISPLAY, stepDisplaySize } = await import(displayUrl);
const { applyTerminalDisplay } = await import(moduleUrl(
  read("../apps/web/src/terminalLayout.ts").replace('"./terminalDisplay"', JSON.stringify(displayUrl)),
));

function renderer() {
  const calls = [];
  const terminal = {
    cols: 120, rows: 32, options: { fontSize: 14 },
    resize(cols, rows) { this.cols = cols; this.rows = rows; calls.push({ cols, rows }); },
  };
  const screen = {
    get offsetWidth() { return Math.round(terminal.cols * terminal.options.fontSize * 0.6); },
    get offsetHeight() { return terminal.rows * Math.ceil(terminal.options.fontSize * 1.2); },
  };
  return { terminal, screen, calls };
}

test("Web font controls reflow instead of changing mirror mode or zoom", () => {
  for (const mode of ["manual", "width", "contain"]) {
    assert.deepEqual(stepDisplaySize({ ...DEFAULT_DISPLAY, mode, zoom: 60 }, 1, 14), { mode: "manual", fontSize: 15 });
  }
});

test("Web mode fills the viewport at the chosen font, independent of legacy mirror settings", () => {
  for (const mode of ["manual", "width", "contain"]) {
    const { terminal, screen } = renderer();
    let previous;
    for (const fontSize of [8, 14, 24, 36]) {
      const result = applyTerminalDisplay(terminal, screen, 1200, 600,
        { ...DEFAULT_DISPLAY, mode, fontSize, zoom: 60 }, true);
      assert.equal(result.fontSize, fontSize);
      assert.ok(result.width <= 1201 && result.width >= 1200 - fontSize * 0.6 - 1);
      assert.ok(result.height <= 600 && result.height > 600 - Math.ceil(fontSize * 1.2));
      if (previous) { assert.ok(result.cols < previous.cols); assert.ok(result.rows < previous.rows); }
      previous = result;
    }
  }
});

test("phone keyboard, toolbar and split-pane space drive rows/columns, not font size", () => {
  const { terminal, screen } = renderer();
  const full = applyTerminalDisplay(terminal, screen, 390, 640, DEFAULT_DISPLAY, true);
  const keyboard = applyTerminalDisplay(terminal, screen, 390, 260, DEFAULT_DISPLAY, true);
  assert.equal(keyboard.cols, full.cols);
  assert.ok(keyboard.rows < full.rows);
  assert.ok(keyboard.height <= 260);
  const split = applyTerminalDisplay(terminal, screen, 195, 260, DEFAULT_DISPLAY, true);
  assert.ok(split.cols < keyboard.cols);
  assert.equal(split.fontSize, 14);
  const restored = applyTerminalDisplay(terminal, screen, 390, 640, DEFAULT_DISPLAY, true);
  assert.deepEqual(restored, full);
});

test("repeated layouts are stable; replay grid is restored after output without a changed request target", () => {
  const { terminal, screen, calls } = renderer();
  const initial = applyTerminalDisplay(terminal, screen, 1200, 600, DEFAULT_DISPLAY, true);
  for (let n = 0; n < 20; n++) {
    assert.deepEqual(applyTerminalDisplay(terminal, screen, 1200, 600, DEFAULT_DISPLAY, true), initial);
  }
  assert.equal(calls.length, 1);
  terminal.resize(80, 24); // a recorded replay batch uses its original dimensions
  assert.deepEqual(applyTerminalDisplay(terminal, screen, 1200, 600, DEFAULT_DISPLAY, true), initial);
});

test("desktop mirror preserves grid in all modes and across ownership transitions", () => {
  for (const mode of ["manual", "width", "contain"]) {
    const { terminal, screen, calls } = renderer();
    const prefs = { ...DEFAULT_DISPLAY, mode, fontSize: 24 };
    applyTerminalDisplay(terminal, screen, 390, 260, prefs, false);
    assert.equal(terminal.cols, 120);
    assert.equal(terminal.rows, 32);
    assert.equal(calls.length, 0);
    applyTerminalDisplay(terminal, screen, 390, 260, prefs, true);
    assert.equal(terminal.options.fontSize, 24);
    terminal.resize(100, 40); // desktop reclaims the shared PTY
    applyTerminalDisplay(terminal, screen, 390, 260, prefs, false);
    assert.equal(terminal.cols, 100);
    assert.equal(terminal.rows, 40);
  }
});

test("shared mirror fits width by default and larger manual fonts allow scrolling", () => {
  const { terminal, screen } = renderer();
  const contained = applyTerminalDisplay(terminal, screen, 390, 260, DEFAULT_DISPLAY, false);
  assert.ok(contained.width <= 390);
  const manual = applyTerminalDisplay(terminal, screen, 390, 260,
    { ...DEFAULT_DISPLAY, mode: "manual", fontSize: 24 }, false);
  assert.ok(manual.width > 390 && manual.height > 260);
});

test("short desktop grids never enlarge at fit width and old zoom cannot change the result", () => {
  const { terminal, screen, calls } = renderer();
  const fitted = applyTerminalDisplay(terminal, screen, 2000, 600, { ...DEFAULT_DISPLAY, zoom: 300 }, false);
  assert.equal(fitted.fontSize, 14);
  assert.equal(calls.length, 0);
  assert.deepEqual(applyTerminalDisplay(terminal, screen, 2000, 600, { ...DEFAULT_DISPLAY, zoom: 60 }, false), fitted);
});

test("cursor reveal leaves visible cells stable and reveals cells beyond either edge", async () => {
  const { revealTerminalCell } = await import(moduleUrl(read("../apps/web/src/terminalCursorView.ts")));
  assert.equal(revealTerminalCell(100, 300, 180, 10), 100);
  assert.equal(revealTerminalCell(100, 300, 70, 10), 70);
  assert.equal(revealTerminalCell(100, 300, 600, 10), 310);
  assert.equal(revealTerminalCell(0, 200, 430, 20), 250);
  assert.equal(revealTerminalCell(0, 200, -1, 20), 0);
});

test("grid limits and unmeasurable screen do not generate invalid resize", () => {
  const { terminal, screen } = renderer();
  let result = applyTerminalDisplay(terminal, screen, 1, 1, DEFAULT_DISPLAY, true);
  assert.equal(result.cols, 2);
  assert.equal(result.rows, 1);
  result = applyTerminalDisplay(terminal, screen, 100000, 100000, DEFAULT_DISPLAY, true);
  assert.equal(result.cols, 500);
  assert.equal(result.rows, 300);
  assert.equal(applyTerminalDisplay(terminal, { offsetWidth: 0, offsetHeight: 0 }, 100, 100, DEFAULT_DISPLAY, true), null);
});

test("real component gates resize on visibility/output drain and deduplicates requested grid", () => {
  const component = read("../apps/web/src/WebTerminal.tsx");
  const report = component.slice(component.indexOf("const reportSize ="), component.indexOf("let lastReportedSize"));
  assert.ok(report.indexOf("if (!activeRef.current) return") < report.indexOf("applyTerminalDisplay("));
  assert.match(report, /ownsSize && \(draining \|\| replayFrames \|\| renderQueue.length \|\| queuedChunks.length\)/);
  assert.match(report, /container.clientHeight/);
  assert.doesNotMatch(report, /shell.clientHeight|shell.clientWidth/);
  assert.match(report, /if \(ownsSize\) \{[\s\S]*requested !== lastReportedSize[\s\S]*resizeRef.current/);
  assert.match(component, /data-display-fit/);
  assert.doesNotMatch(component, /<select data-display-mode/);
  assert.doesNotMatch(component, /data-display-(?:width|height)/);
  assert.match(component, /desktopCols/);
  assert.match(component, /terminal\.resize\(desktopCols, desktopRows\)/);
  assert.match(component, /desktopGeometryRef\.current[\s\S]*terminal\.resize\(geometry\.cols, geometry\.rows\)/);
});
