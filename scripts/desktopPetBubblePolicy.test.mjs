import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-desktop-pet-bubble-policy-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/lib/desktopPetBubble.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "desktopPetBubble.ts",
}).outputText;
const outputPath = join(tempDir, "desktopPetBubble.mjs");
writeFileSync(outputPath, output, "utf8");
const bubble = await import(pathToFileURL(outputPath).href);

function target(overrides = {}) {
  return {
    sessionId: "session-1",
    daemonOnly: false,
    sessionTitle: "Task",
    projectName: "Project",
    status: "running",
    attentionKind: null,
    message: null,
    active: false,
    updatedAt: 1_000,
    handoffCandidate: false,
    handoffEligible: false,
    handoffRecoverable: false,
    handoffReason: null,
    handedOff: false,
    handoffPhase: null,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    mood: "working",
    sessionId: "session-1",
    daemonOnly: false,
    sessionTitle: "Task",
    projectName: "Project",
    runningCount: 1,
    attentionCount: 0,
    statusCounts: { green: 1, red: 0, blue: 0 },
    updatedAt: 1_000,
    targets: [target()],
    decisionRequests: [],
    incidents: [],
    handoff: null,
    handoffPlatforms: [],
    handoffBusy: false,
    ...overrides,
  };
}

test("unified content orders blocking decisions before incidents and one latest completion", () => {
  const content = bubble.deriveDesktopPetBubbleContent(snapshot({
    targets: [
      target({ sessionId: "done-old", status: "done", updatedAt: 2_000, message: "Old" }),
      target({ sessionId: "done-new", status: "done", updatedAt: 3_000, message: "Complete output" }),
      target({ sessionId: "running", status: "running", updatedAt: 4_000 }),
    ],
    decisionRequests: [
      { requestId: "question", kind: "question", createdAt: 1_000, questions: [] },
      { requestId: "permission", kind: "permission", createdAt: 2_000, questions: [] },
      { requestId: "questionnaire", kind: "questionnaire", createdAt: 500, questions: [] },
    ],
    incidents: [
      { id: "older", createdAt: 1_000 },
      { id: "newer", createdAt: 2_000 },
    ],
  }));

  assert.deepEqual(content.decisions.map((request) => request.requestId), [
    "permission",
    "questionnaire",
    "question",
  ]);
  assert.deepEqual(content.incidents.map((incident) => incident.id), ["newer", "older"]);
  assert.equal(content.completion.sessionId, "done-new");
  assert.equal(content.completion.message, "Complete output");
  assert.equal(content.completion.id, "done-new:3000");
});

test("latest completion tie-break is stable and input arrays are not mutated", () => {
  const targets = [
    target({ sessionId: "z-session", status: "done", updatedAt: 3_000 }),
    target({ sessionId: "a-session", status: "done", updatedAt: 3_000 }),
  ];
  const decisions = [
    { requestId: "late", kind: "question", createdAt: 2_000, questions: [] },
    { requestId: "early", kind: "question", createdAt: 1_000, questions: [] },
  ];
  const content = bubble.deriveDesktopPetBubbleContent(snapshot({ targets, decisionRequests: decisions }));

  assert.equal(content.completion.sessionId, "a-session");
  assert.deepEqual(targets.map((item) => item.sessionId), ["z-session", "a-session"]);
  assert.deepEqual(decisions.map((item) => item.requestId), ["late", "early"]);
});

test("completion lifetime starts at source time and duplicate snapshots do not reset it", () => {
  const summary = {
    id: "session-1:1000",
    sessionId: "session-1",
    daemonOnly: false,
    sessionTitle: "Task",
    projectName: "Project",
    message: "Done",
    updatedAt: 1_000,
  };
  const initial = bubble.updateDesktopPetCompletionTimer(null, summary, 2_000, false);
  assert.deepEqual(initial, {
    summaryId: summary.id,
    expiresAt: 9_000,
    remainingMs: 7_000,
    paused: false,
  });

  const duplicate = bubble.updateDesktopPetCompletionTimer(initial, summary, 3_000, false);
  assert.equal(duplicate.expiresAt, 9_000);
  assert.equal(duplicate.remainingMs, 6_000);
  assert.equal(bubble.updateDesktopPetCompletionTimer(duplicate, summary, 9_000, false), null);
});

test("hover pauses only the remaining completion lifetime", () => {
  const summary = {
    id: "session-1:1000",
    sessionId: "session-1",
    daemonOnly: false,
    sessionTitle: "Task",
    projectName: "Project",
    message: "Done",
    updatedAt: 1_000,
  };
  const initial = bubble.updateDesktopPetCompletionTimer(null, summary, 1_000, false);
  const paused = bubble.updateDesktopPetCompletionTimer(initial, summary, 4_000, true);
  const stillPaused = bubble.updateDesktopPetCompletionTimer(paused, summary, 7_000, true);
  const resumed = bubble.updateDesktopPetCompletionTimer(stillPaused, summary, 7_000, false);

  assert.equal(paused.remainingMs, 5_000);
  assert.equal(stillPaused.remainingMs, 5_000);
  assert.equal(resumed.expiresAt, 12_000);
  assert.equal(bubble.updateDesktopPetCompletionTimer(resumed, summary, 12_000, false), null);
});

test("coordinator admission survives source expiry until Bubble reports the completion empty", () => {
  const summary = {
    id: "session-1:1000",
    sessionId: "session-1",
    daemonOnly: false,
    sessionTitle: "Task",
    projectName: "Project",
    message: "Done",
    updatedAt: 1_000,
  };
  const admitted = bubble.updateDesktopPetActiveCompletionId(null, summary, null, 2_000);
  assert.equal(admitted, summary.id);
  assert.equal(
    bubble.updateDesktopPetActiveCompletionId(admitted, summary, null, 12_000),
    summary.id,
  );
  assert.equal(
    bubble.updateDesktopPetActiveCompletionId(admitted, summary, summary.id, 12_000),
    null,
  );
  assert.equal(bubble.updateDesktopPetActiveCompletionId(null, summary, null, 12_000), null);
});

test("expired source events stay hidden while a newer completion gets a fresh timer", () => {
  const oldSummary = { id: "old", updatedAt: 1_000 };
  const newSummary = { id: "new", updatedAt: 10_000 };

  assert.equal(bubble.updateDesktopPetCompletionTimer(null, oldSummary, 10_000, false), null);
  assert.equal(
    bubble.updateDesktopPetCompletionTimer(null, newSummary, 10_000, false).remainingMs,
    bubble.DESKTOP_PET_COMPLETION_DURATION_MS,
  );
  assert.equal(bubble.updateDesktopPetCompletionTimer(null, null, 10_000, false), null);
});
