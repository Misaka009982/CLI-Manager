import type { Operation } from "./domain";

type Listener = { deviceId: string; kind: string; receive: (operation: Operation) => void };
const listeners = new Map<string, Listener>();

export function isFileOperationComplete(operation: Operation): boolean {
  return ["succeeded", "failed", "rejected", "timed_out", "canceled"].includes(operation.status);
}

// Subscribe before POST: a local host can finish before the HTTP response arrives.
export function subscribeFileOperation(
  idempotencyKey: string, deviceId: string, kind: string, receive: Listener["receive"],
): () => void {
  const listener = { deviceId, kind, receive };
  listeners.set(idempotencyKey, listener);
  return () => { if (listeners.get(idempotencyKey) === listener) listeners.delete(idempotencyKey); };
}

export function publishFileOperation(operation: Operation): void {
  const listener = listeners.get(operation.idempotencyKey);
  if (listener && listener.deviceId === operation.deviceId && listener.kind === operation.kind
    && isFileOperationComplete(operation)) listener.receive(operation);
}
