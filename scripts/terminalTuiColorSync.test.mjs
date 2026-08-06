import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-terminal-tui-color-sync-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

globalThis.window = globalThis;
globalThis.requestAnimationFrame = (callback) => {
  callback(performance.now());
  return 1;
};
globalThis.cancelAnimationFrame = () => {};

writeFileSync(join(tempDir, "terminalTuiDisplay.mjs"), `
export let normalizeCalls = 0;
export function hasCodexTuiViewport() { return false; }
export function hasKnownAiTuiViewport() { return false; }
export function hasTuiComposerPromptViewport() { return false; }
export function normalizeTerminalTuiComposerBackground() { normalizeCalls += 1; }
`);
writeFileSync(join(tempDir, "TerminalCliContext.mjs"), `
export function isClaudeTerminalContext() { return false; }
export function isCodexTerminalContext() { return false; }
`);

const source = readFileSync(new URL("../src/lib/terminalTuiColorSync.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "terminalTuiColorSync.ts",
}).outputText
  .replace('from "./terminalTuiDisplay"', 'from "./terminalTuiDisplay.mjs"')
  .replace('from "../terminal/browser/TerminalCliContext"', 'from "./TerminalCliContext.mjs"');
const modulePath = join(tempDir, "terminalTuiColorSync.mjs");
writeFileSync(modulePath, transpiled, "utf8");

const { createTerminalTuiColorSyncController } = await import(pathToFileURL(modulePath).href);
const tuiDisplayStub = await import(pathToFileURL(join(tempDir, "terminalTuiDisplay.mjs")).href);

test("hidden terminal skips TUI color scanning until it becomes visible", () => {
  const options = {
    isVisible: false,
    isTransparent: false,
    isLightTheme: false,
    terminalTextColor: undefined,
    tuiUserColor: undefined,
    tuiAssistantColor: undefined,
    getContext: () => ({}),
  };
  const controller = createTerminalTuiColorSyncController(() => options);
  controller.normalize({});
  assert.equal(tuiDisplayStub.normalizeCalls, 0);

  options.isVisible = true;
  controller.normalize({});
  assert.equal(tuiDisplayStub.normalizeCalls, 1);
  controller.dispose();
});
