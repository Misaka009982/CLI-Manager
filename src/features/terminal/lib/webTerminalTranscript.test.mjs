import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalTranscriptPage } from "./webTerminalTranscript.ts";

const session = { id: "pty-a", cliSessionId: "cli-a" };
const detail = {
  session_id: "cli-a", source: "claude", messages: [
    { role: "user", content: "raw-internal-tool", parts: [{ kind: "text", content: "hello" }] },
    { role: "assistant", content: "hidden tool arguments", parts: [
      { kind: "tool_call", content: "secret internal args", tool_name: "Bash" },
      { kind: "text", content: "reply" },
    ] },
    { role: "system", content: "internal instructions" },
    { role: "assistant", content: "flattened secret", parts: [{ kind: "tool_call", content: "secret" }] },
  ],
};
test("transcript exports canonical visible text and excludes flattened/internal data", () => {
  const page = terminalTranscriptPage(session, detail);
  assert.equal(page.available, true);
  assert.deepEqual(page.messages.map((m) => [m.role, m.text]), [["user", "hello"], ["assistant", "reply"]]);
  assert.equal(JSON.stringify(page).includes("secret"), false);
});
test("no binding and mismatched native history cannot expose another conversation", () => {
  assert.equal(terminalTranscriptPage({ id: "pty-a" }, detail).reason, "unbound");
  assert.equal(terminalTranscriptPage(session, { ...detail, session_id: "other" }).reason, "missing");
});
test("older pages preserve stable source message identity and bound output", () => {
  const long = { ...detail, messages: Array.from({ length: 105 }, (_, i) => ({
    role: "assistant", parts: [{ kind: "text", content: `message ${i}` }],
  })) };
  const tail = terminalTranscriptPage(session, long);
  assert.equal(tail.start, 65);
  assert.equal(tail.messages.length, 40);
  const older = terminalTranscriptPage(session, long, tail.start);
  assert.equal(older.messages.at(-1).text, "message 64");
  assert.notEqual(older.messages.at(-1).id, tail.messages[0].id);
});
test("truncating text at the wire budget must not split a surrogate pair", () => {
  const text = "a".repeat(3999) + "🚀" + " remainder";
  const page = terminalTranscriptPage(session, { ...detail, messages: [
    { role: "assistant", parts: [{ kind: "text", content: text }] },
  ] });
  assert.equal(page.messages[0].text.isWellFormed(), true, "Rust JSON decoding rejects a lone surrogate");
  assert.equal(page.messages[0].text, "a".repeat(3999));
  assert.equal(page.messages[0].truncated, true);
});

test("opt-in exports tool/thought blocks with identity, omitting system and unknown data", () => {
  for (const source of ["codex", "claude"]) {
    const page = terminalTranscriptPage(session, { ...detail, source, messages: [
      { role: "assistant", content: "NEVER_FLATTEN", parts: [
        { kind: "reasoning", content: "check state" },
        { kind: "tool_call", content: '{"command":"git status"}', tool_name: "Bash", call_id: "c1" },
        { kind: "system", content: "NEVER_SYSTEM" }, { kind: "unknown", content: "NEVER_SIGNATURE" },
        { kind: "text", content: "NEVER_MISCLASSIFIED", call_id: "c1" },
      ] },
      { role: "tool", parts: [{ kind: "tool_result", content: "clean", call_id: "c1" }] },
      { role: "assistant", parts: [{ kind: "text", content: "Done" }] },
    ] }, undefined, true);
    assert.equal(page.messages.length, 3);
    assert.deepEqual(page.messages[0].parts.map((part) => part.kind), ["reasoning", "tool_call"]);
    assert.equal(page.messages[0].parts[1].toolName, "Bash");
    assert.equal(page.messages[0].parts[1].callId, page.messages[1].parts[0].callId);
    assert.equal(page.messages[1].role, "tool");
    assert.equal(page.messages[2].text, "Done");
    assert.ok(!JSON.stringify(page).includes("NEVER_"));
  }
});

test("detailed pages fit the byte envelope and all source rows remain reachable", () => {
  const huge = { ...detail, messages: Array.from({ length: 95 }, () => ({ role: "assistant", parts: [
    { kind: "text", content: "\u0001".repeat(4000) },
    ...Array.from({ length: 30 }, (_, i) => ({ kind: "tool_call", content: "\u0001".repeat(3999) + "🚀end", call_id: `call-${i}` })),
  ] })) };
  const ids = [];
  let before;
  do {
    const page = terminalTranscriptPage(session, huge, before, true);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 512 * 1024);
    assert.ok(page.messages.length > 0);
    assert.ok(page.start < (before ?? 95));
    assert.ok(page.messages.every((message) => message.partsTruncated));
    assert.ok(page.messages.every((message) => message.parts.every((part) => part.text.isWellFormed())));
    ids.unshift(...page.messages.map((message) => message.id));
    before = page.start;
  } while (before > 0);
  assert.deepEqual(ids, Array.from({ length: 95 }, (_, i) => `cli-a:${i}`));
});

test("long call IDs are omitted instead of truncated into colliding identities", () => {
  const page = terminalTranscriptPage(session, { ...detail, messages: [{ role: "assistant", parts: [
    { kind: "tool_call", content: "cmd", call_id: "x".repeat(257) },
  ] }] }, undefined, true);
  assert.equal(page.messages[0].parts[0].callId, undefined);
});

test("verbose activity cannot consume the ordinary answer's reserved budget", () => {
  const page = terminalTranscriptPage(session, { ...detail, messages: [{ role: "assistant", parts: [
    ...Array.from({ length: 50 }, () => ({ kind: "tool_call", content: "x".repeat(4000) })),
    { kind: "text", content: "Final answer" },
  ] }] }, undefined, true);
  assert.equal(page.messages[0].parts.at(-1).text, "Final answer");
  assert.equal(page.messages[0].partsTruncated, true);
});

test("oversized display metadata cannot stall pagination at an unexportable message", () => {
  const page = terminalTranscriptPage(session, { ...detail, messages: [{ role: "assistant",
    model: "x".repeat(600_000), timestamp: "x".repeat(600_000), parts: [{ kind: "text", content: "Answer" }],
  }] }, undefined, true);
  assert.equal(page.start, 0);
  assert.equal(page.messages[0].text, "Answer");
  assert.equal(page.messages[0].model.length, 256);
  assert.equal(page.messages[0].at, undefined);
});
