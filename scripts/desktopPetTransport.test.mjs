import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-desktop-pet-transport-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/lib/desktopPetTransport.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "desktopPetTransport.ts",
}).outputText;
const outputPath = join(tempDir, "desktopPetTransport.mjs");
writeFileSync(outputPath, output, "utf8");
const transport = await import(pathToFileURL(outputPath).href);

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
    updatedAt: 1000,
    targets: [{
      sessionId: "session-1",
      daemonOnly: false,
      sessionTitle: "Task",
      projectName: "Project",
      status: "running",
      attentionKind: null,
      message: null,
      active: true,
      updatedAt: 1000,
      handoffCandidate: true,
      handoffEligible: false,
      handoffRecoverable: true,
      handoffReason: "missing_cli_session_id",
      handedOff: false,
      handoffPhase: null,
    }],
    decisionRequests: [],
    incidents: [],
    handoff: null,
    handoffPlatforms: [],
    handoffBusy: false,
    ...overrides,
  };
}

test("running output timestamps do not trigger a new desktop pet delivery", () => {
  const first = snapshot();
  const next = snapshot({
    updatedAt: 2000,
    targets: [{ ...first.targets[0], updatedAt: 2000 }],
  });
  assert.equal(
    transport.desktopPetSnapshotFingerprint(first),
    transport.desktopPetSnapshotFingerprint(next),
  );
});

test("visible desktop pet state changes still trigger delivery", () => {
  const first = snapshot();
  const next = snapshot({
    mood: "waiting",
    attentionCount: 1,
    targets: [{ ...first.targets[0], status: "attention" }],
  });
  assert.notEqual(
    transport.desktopPetSnapshotFingerprint(first),
    transport.desktopPetSnapshotFingerprint(next),
  );
});

test("decision requests and incidents trigger delivery even when target state is unchanged", () => {
  const first = snapshot();
  const decision = snapshot({
    statusCounts: { green: 1, red: 0, blue: 1 },
    decisionRequests: [{
      requestId: "request-1",
      brokerEpoch: "epoch-1",
      sourceInstanceId: "pi-1",
      tabId: "session-1",
      sessionId: "pi-session-1",
      kind: "question",
      title: "Choose",
      message: "Pick one",
      questions: [],
      createdAt: 1000,
    }],
  });
  const incident = snapshot({
    mood: "error",
    statusCounts: { green: 1, red: 1, blue: 0 },
    incidents: [{
      id: "incident-1",
      tabId: "session-1",
      sessionId: "pi-session-1",
      daemonOnly: false,
      title: "Interrupted",
      message: "Connection lost",
      createdAt: 1000,
    }],
  });
  assert.notEqual(
    transport.desktopPetSnapshotFingerprint(first),
    transport.desktopPetSnapshotFingerprint(decision),
  );
  assert.notEqual(
    transport.desktopPetSnapshotFingerprint(first),
    transport.desktopPetSnapshotFingerprint(incident),
  );
});

test("success timestamps remain meaningful for the success timeout", () => {
  const first = snapshot({ mood: "success", updatedAt: 1000 });
  const next = snapshot({ mood: "success", updatedAt: 2000 });
  assert.notEqual(
    transport.desktopPetSnapshotFingerprint(first),
    transport.desktopPetSnapshotFingerprint(next),
  );
});

test("done target timestamps participate in Bubble completion delivery", () => {
  const first = snapshot({
    mood: "success",
    targets: [
      { ...snapshot().targets[0], sessionId: "done-a", status: "done", updatedAt: 1_000 },
      { ...snapshot().targets[0], sessionId: "done-b", status: "done", updatedAt: 2_000 },
    ],
  });
  const next = snapshot({
    mood: "success",
    targets: [
      { ...first.targets[0], updatedAt: 3_000 },
      first.targets[1],
    ],
  });
  assert.notEqual(
    transport.desktopPetSnapshotFingerprint(first),
    transport.desktopPetSnapshotFingerprint(next),
  );
});

test("lifecycle tokens and surface epochs use bounded stable identities", () => {
  const entropy = Uint8Array.from({ length: 16 }, (_, index) => index);
  assert.equal(
    transport.createDesktopPetLifecycleToken(entropy),
    "000102030405060708090a0b0c0d0e0f",
  );
  assert.throws(
    () => transport.createDesktopPetLifecycleToken(new Uint8Array(15)),
    /entropy_too_short/,
  );
  assert.equal(transport.shouldAcceptDesktopPetSurfaceEpoch(null, "surface_epoch_1234"), true);
  assert.equal(
    transport.shouldAcceptDesktopPetSurfaceEpoch(
      "another_surface_12",
      "surface_epoch_1234",
      new Set(["surface_epoch_1234"]),
    ),
    false,
  );
  assert.equal(
    transport.shouldAcceptDesktopPetSurfaceEpoch("surface_epoch_1234", "surface_epoch_1234"),
    false,
  );
  assert.equal(transport.shouldAcceptDesktopPetSurfaceEpoch(null, "short"), false);
  assert.equal(
    transport.desktopPetLifecycleTokenMatches("token", "token"),
    true,
  );
  assert.equal(
    transport.desktopPetLifecycleTokenMatches("token", "other"),
    false,
  );
});

test("surface deliveries carry comparable revisions and reject missing epochs", () => {
  const firstRevision = transport.nextDesktopPetDeliveryRevision(0, 1_000);
  const nextRevision = transport.nextDesktopPetDeliveryRevision(firstRevision, 1_000);
  assert.equal(firstRevision, 1_024_000);
  assert.equal(nextRevision, firstRevision + 1);

  const payload = transport.createDesktopPetSurfaceEventPayload(
    { visible: true },
    "0123456789abcdef0123456789abcdef",
    "surface_epoch_1234",
    nextRevision,
  );
  assert.deepEqual(payload, {
    visible: true,
    lifecycleToken: "0123456789abcdef0123456789abcdef",
    surfaceEpoch: "surface_epoch_1234",
    deliveryRevision: nextRevision,
  });
  assert.equal(
    transport.shouldAcceptDesktopPetConfigDelivery(
      "surface_epoch_1234",
      firstRevision,
      payload,
    ),
    true,
  );
  assert.equal(
    transport.shouldAcceptDesktopPetConfigDelivery(
      "surface_epoch_1234",
      nextRevision,
      payload,
    ),
    false,
  );
  assert.equal(
    transport.shouldAcceptDesktopPetSnapshotDelivery(
      payload.lifecycleToken,
      payload.surfaceEpoch,
      nextRevision + 1,
      firstRevision,
      payload,
    ),
    false,
  );
  assert.equal(
    transport.shouldAcceptDesktopPetSnapshotDelivery(
      payload.lifecycleToken,
      payload.surfaceEpoch,
      firstRevision,
      firstRevision,
      payload,
    ),
    true,
  );
  assert.throws(
    () => transport.createDesktopPetSurfaceEventPayload(
      {},
      "0123456789abcdef0123456789abcdef",
      null,
      nextRevision,
    ),
    /surface_epoch_unavailable/,
  );
  assert.throws(
    () => transport.createDesktopPetSurfaceEventPayload(
      {},
      "0123456789abcdef0123456789abcdef",
      "surface_epoch_1234",
      0,
    ),
    /delivery_revision_invalid/,
  );
});

test("layout handshake rejects duplicate requests, stale measurements, and stale geometry", () => {
  const lifecycleToken = "0123456789abcdef0123456789abcdef";
  const petSurfaceEpoch = "pet_surface_epoch_1";
  const bubbleSurfaceEpoch = "bubble_surface_ep1";
  const request = { lifecycleToken, petSurfaceEpoch, revision: 4 };
  assert.equal(
    transport.shouldAcceptDesktopPetBubbleLayoutRequest(lifecycleToken, null, request),
    true,
  );
  assert.equal(
    transport.shouldAcceptDesktopPetBubbleLayoutRequest(lifecycleToken, request, request),
    false,
  );

  const measurement = {
    ...request,
    bubbleSurfaceEpoch,
    measurementRevision: 7,
    contentFingerprint: "content-1",
    naturalWidth: 410,
    naturalHeight: 320,
  };
  assert.equal(transport.shouldAcceptDesktopPetBubbleMeasurement({
    expectedLifecycleToken: lifecycleToken,
    expectedPetSurfaceEpoch: petSurfaceEpoch,
    expectedLayoutRevision: request.revision,
    previous: null,
    candidate: measurement,
  }), true);
  assert.equal(transport.shouldAcceptDesktopPetBubbleMeasurement({
    expectedLifecycleToken: lifecycleToken,
    expectedPetSurfaceEpoch: petSurfaceEpoch,
    expectedLayoutRevision: request.revision,
    previous: measurement,
    candidate: measurement,
  }), false);
  assert.equal(transport.shouldAcceptDesktopPetBubbleMeasurement({
    expectedLifecycleToken: lifecycleToken,
    expectedPetSurfaceEpoch: petSurfaceEpoch,
    expectedLayoutRevision: request.revision,
    previous: null,
    candidate: { ...measurement, naturalHeight: 0 },
  }), false);

  const geometry = {
    ...request,
    bubbleSurfaceEpoch,
    measurementRevision: measurement.measurementRevision,
    geometryRevision: 9,
    placement: "above",
    logicalWidth: 410,
    logicalHeight: 320,
    arrowOffset: 205,
  };
  assert.equal(transport.shouldAcceptDesktopPetBubbleGeometry({
    expectedLifecycleToken: lifecycleToken,
    expectedBubbleSurfaceEpoch: bubbleSurfaceEpoch,
    expectedMeasurementRevision: measurement.measurementRevision,
    previousGeometryRevision: 8,
    request,
    candidate: geometry,
  }), true);
  assert.equal(transport.shouldAcceptDesktopPetBubbleGeometry({
    expectedLifecycleToken: lifecycleToken,
    expectedBubbleSurfaceEpoch: bubbleSurfaceEpoch,
    expectedMeasurementRevision: measurement.measurementRevision,
    previousGeometryRevision: geometry.geometryRevision,
    request,
    candidate: geometry,
  }), false);
});

test("delivery plans fan visible state to both surfaces and commit only after total success", () => {
  const previous = { configKey: null, snapshotKey: null };
  const plan = transport.createDesktopPetDeliveryPlan({
    force: false,
    petVisible: true,
    bubbleVisible: true,
    configKey: "config-1",
    snapshotKey: "snapshot-1",
    previous,
  });
  assert.deepEqual(plan.configTargets, ["desktop-pet", "desktop-pet-bubble"]);
  assert.deepEqual(plan.snapshotTargets, ["desktop-pet", "desktop-pet-bubble"]);
  assert.equal(transport.commitDesktopPetDeliveryPlan(previous, plan, false), previous);
  assert.deepEqual(transport.commitDesktopPetDeliveryPlan(previous, plan, true), {
    configKey: "config-1",
    snapshotKey: "snapshot-1",
  });
});

test("delivery execution starts snapshots only after every config succeeds", async () => {
  const plan = transport.createDesktopPetDeliveryPlan({
    force: true,
    petVisible: true,
    bubbleVisible: true,
    configKey: "config-ordered",
    snapshotKey: "snapshot-ordered",
    previous: { configKey: null, snapshotKey: null },
  });
  const order = [];
  await transport.executeDesktopPetDeliveryPlan(
    plan,
    async (surface) => {
      order.push(`config:start:${surface}`);
      await Promise.resolve();
      order.push(`config:end:${surface}`);
    },
    async (surface) => {
      order.push(`snapshot:${surface}`);
    },
  );
  const firstSnapshot = order.findIndex((entry) => entry.startsWith("snapshot:"));
  const lastConfigEnd = Math.max(
    ...order.map((entry, index) => entry.startsWith("config:end:") ? index : -1),
  );
  assert.ok(firstSnapshot > lastConfigEnd);

  const failedOrder = [];
  await assert.rejects(() => transport.executeDesktopPetDeliveryPlan(
    plan,
    async (surface) => {
      failedOrder.push(`config:${surface}`);
      if (surface === "desktop-pet-bubble") throw new Error("config failed");
    },
    async (surface) => {
      failedOrder.push(`snapshot:${surface}`);
    },
  ));
  assert.equal(failedOrder.some((entry) => entry.startsWith("snapshot:")), false);
});

test("hidden Bubble receives clearing config but no retained snapshot", () => {
  const plan = transport.createDesktopPetDeliveryPlan({
    force: true,
    petVisible: true,
    bubbleVisible: false,
    configKey: "config-2",
    snapshotKey: "snapshot-2",
    previous: { configKey: "config-1", snapshotKey: "snapshot-1" },
  });
  assert.deepEqual(plan.configTargets, ["desktop-pet", "desktop-pet-bubble"]);
  assert.deepEqual(plan.snapshotTargets, ["desktop-pet"]);

  const hidden = transport.createDesktopPetDeliveryPlan({
    force: true,
    petVisible: false,
    bubbleVisible: false,
    configKey: "config-3",
    snapshotKey: "snapshot-3",
    previous: { configKey: "config-2", snapshotKey: "snapshot-2" },
  });
  assert.deepEqual(hidden.configTargets, ["desktop-pet", "desktop-pet-bubble"]);
  assert.deepEqual(hidden.snapshotTargets, []);
});

test("background daemon polling reuses unchanged task arrays", () => {
  const tasks = [{
    sessionId: "session-1",
    cwd: "/work",
    alive: true,
    taskStatus: "running",
    taskUpdatedAtMs: 1000,
    createdAtMs: 500,
  }];
  assert.equal(transport.sameBackgroundPetTasks(tasks, structuredClone(tasks)), true);
  assert.equal(
    transport.sameBackgroundPetTasks(tasks, [{ ...tasks[0], taskStatus: "done" }]),
    false,
  );
});
