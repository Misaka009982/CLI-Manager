import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const storeSource = readFileSync(
  new URL("../src/stores/historyStore.ts", import.meta.url),
  "utf8",
);
const commandSource = readFileSync(
  new URL("../src-tauri/src/commands/history_title.rs", import.meta.url),
  "utf8",
);

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("smart-title IPC sends the Rust struct argument under request", () => {
  const generate = sourceBlock(storeSource, "generateSmartTitle: async", "clearSmartTitle: async");
  const clear = sourceBlock(storeSource, "clearSmartTitle: async", "updateMessage: async");

  assert.match(commandSource, /fn history_title_generate\(\s*request: HistoryTitleGenerateRequest,/);
  assert.match(commandSource, /fn history_title_clear\(\s*request: HistoryTitleClearRequest,/);
  assert.match(generate, /invoke<unknown>\("history_title_generate", \{\s*request: \{/);
  assert.match(clear, /invoke<unknown>\("history_title_clear", \{\s*request: \{/);
});
