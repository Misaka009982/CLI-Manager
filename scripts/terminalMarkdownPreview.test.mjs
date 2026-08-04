import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const previewSource = readFileSync(
  new URL("../src/components/terminal/TerminalMarkdownPreview.tsx", import.meta.url),
  "utf8",
);
const historyStoreSource = readFileSync(
  new URL("../src/stores/historyStore.ts", import.meta.url),
  "utf8",
);
const terminalSource = readFileSync(
  new URL("../src/components/XTermTerminal.tsx", import.meta.url),
  "utf8",
);

test("markdown preview waits for the bound session catalog refresh", () => {
  assert.match(previewSource, /const waitForCatalogRefresh = attempt === 0/);
  assert.match(previewSource, /waitForCatalogRefresh\s*\}/);
  assert.match(historyStoreSource, /wait:\s*waitForCatalogRefresh/);
});

test("failed markdown preview loads are retryable and background terminal layout stays intact", () => {
  const successBlock = previewSource.match(
    /if \(detail\) \{([\s\S]*?)setContent\(selectFinalAssistantContent\(detail\)\);/,
  );
  assert.ok(successBlock, "expected the successful detail branch");
  assert.match(successBlock[1], /loadedTriggerRef\.current\s*=\s*trigger/);

  const effectBlock = previewSource.match(
    /if \(loadedTriggerRef\.current === previewLoadTrigger\) return;([\s\S]*?)\n  \}, \[hookStatus,/,
  );
  assert.ok(effectBlock, "expected the preview load effect");
  assert.doesNotMatch(effectBlock[1], /loadedTriggerRef\.current\s*=\s*previewLoadTrigger/);

  assert.match(terminalSource, /data-bg-enabled/);
  assert.match(terminalSource, /ref=\{containerRef\}/);
});
