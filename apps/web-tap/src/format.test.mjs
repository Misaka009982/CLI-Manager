import assert from "node:assert/strict";
import { test } from "node:test";
import { clock, duration, modelName, readerLines, splitPath } from "./format.ts";
import { groupTurns } from "./turns.ts";

test("model IDs read like the CLIs show them", () => {
  assert.equal(modelName("claude-opus-4-1"), "Opus 4.1");
  assert.equal(modelName("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
  assert.equal(modelName("claude-3-5-haiku-20241022"), "Haiku 3.5");
  assert.equal(modelName("gpt-5-codex"), "GPT-5 Codex");
  assert.equal(modelName("custom-model"), "custom-model");
  assert.equal(modelName(undefined), "");
});

test("footer times are 24-hour and dated when not today", () => {
  const now = new Date(2026, 9, 16, 22, 0);
  assert.equal(clock(new Date(2026, 9, 16, 9, 5).toISOString(), now), "09:05");
  assert.equal(clock(new Date(2026, 9, 15, 23, 40).toISOString(), now), "10/15 23:40");
  assert.equal(clock("not a date", now), "");
  assert.equal(duration(41_000), "41s");
  assert.equal(duration(137_000), "2m 17s");
  assert.deepEqual(splitPath("apps/web-tap/src/App.tsx"), { dir: "apps/web-tap/src", name: "App.tsx" });
});

test("reading view clips drawn rules and trims padded box borders", () => {
  const [top, body, plain] = readerLines(["╭──────────╮", "│ Welcome to Claude Code!        │", "plain text"]);
  assert.deepEqual(top, { text: "╭──────────╮", rule: true });
  assert.deepEqual(body, { text: "│ Welcome to Claude Code!", rule: false });
  assert.deepEqual(plain, { text: "plain text", rule: false });
});

test("interim replies fold under the final answer of each turn", () => {
  const turns = groupTurns([
    { id: "a:0", role: "user", text: "fix it", at: "2026-10-16T10:00:00Z" },
    { id: "a:1", role: "assistant", text: "looking", at: "2026-10-16T10:00:10Z" },
    { id: "a:2", role: "assistant", text: "done", at: "2026-10-16T10:02:17Z", model: "claude-opus-4-1" },
    { id: "a:3", role: "user", text: "thanks" },
  ]);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0].steps.map((message) => message.id), ["a:1"]);
  assert.equal(turns[0].answer.id, "a:2");
  assert.equal(turns[0].elapsed, 137_000);
  assert.equal(turns[1].answer, undefined);
});
