import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Diff, Hunk } from "react-diff-view";
import { parseGitDiffFile } from "../src/features/git/components/diff/gitDiffParser.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const patch = ["diff --git a/example.txt b/example.txt", "--- a/example.txt", "+++ b/example.txt",
  "@@ -10,3 +10,3 @@", " context", "-before", "+<script>after</script>", " end", ""].join("\n");

for (const mode of ["split", "unified"]) {
  test(`shared ${mode} snapshot rows render line numbers and semantic colors without HTML execution`, () => {
    const file = parseGitDiffFile(patch);
    const html = renderToStaticMarkup(createElement(Diff, {
      viewType: mode, diffType: file.type, hunks: file.hunks,
      children: (hunks) => hunks.map((hunk) => createElement(Hunk, { key: hunk.content, hunk })),
    }));
    assert.match(html, /diff-code-delete/);
    assert.match(html, /diff-code-insert/);
    assert.match(html, /diff-gutter[^>]*>11</);
    assert.match(html, /&lt;script&gt;after&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, mode === "split" ? /diff-split/ : /diff-unified/);
  });
}

test("snapshot entry shares bounded worker parsing and visible hunk rendering without desktop state", () => {
  const snapshot = read("../src/features/git/api/GitSnapshotDiff.tsx");
  const parser = read("../src/features/git/components/diff/useGitDiffParser.ts");
  assert.match(snapshot, /normalizeGitDiffPayload/);
  assert.match(snapshot, /useGitDiffParser/);
  assert.match(snapshot, /useVirtualizer/);
  assert.match(snapshot, /getVirtualItems/);
  assert.match(snapshot, /ref=\{virtualizer.measureElement\}/);
  assert.doesNotMatch(snapshot + parser, /@tauri|settingsStore|useGitDiffController|from.*debugConsole/);
  assert.match(read("../src/features/git/components/diff/useGitDiffController.ts"),
    /useGitDiffParser\(diffText, metadata.byteLength, debugConsoleWarn\)/);
});
