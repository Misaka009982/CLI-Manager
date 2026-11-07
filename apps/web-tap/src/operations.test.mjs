import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationRunner } from "./operations.ts";

test("a completed event arriving before POST resolves completes the matching request", async () => {
  let submitted;
  let finishPost;
  const runner = createOperationRunner({
    createOperation: async (deviceId, kind, payload, idempotencyKey) => {
      submitted = { id: "op-a", deviceId, kind, payload, idempotencyKey, status: "running", result: null };
      return new Promise((resolve) => { finishPost = resolve; });
    },
    operation: async () => { throw Error("completed requests must not poll"); },
  });
  const result = runner.run("device-a", "project.start", { targetId: "p1" });
  assert.equal(typeof finishPost, "function", "subscribe and dispatch synchronously before accepting completion events");
  runner.publish({ ...submitted, status: "succeeded", result: { sessionIds: ["pty-a"] } });
  finishPost({ operation: submitted });
  assert.deepEqual(await result, { sessionIds: ["pty-a"] });
});
test("changing scope aborts pending operations and ignores another device's completion", async () => {
  let submitted;
  const runner = createOperationRunner({
    createOperation: async (deviceId, kind, payload, idempotencyKey) => {
      submitted = { id: "op-a", deviceId, kind, payload, idempotencyKey, status: "running", result: null };
      return { operation: submitted };
    }, operation: async () => ({ operation: submitted }),
  });
  const result = runner.run("device-a", "file.list", { projectId: "p1" });
  const rejected = assert.rejects(result, { name: "AbortError" });
  runner.publish({ ...submitted, deviceId: "device-b", status: "succeeded", result: ["wrong"] });
  runner.cancel();
  await rejected;
});
