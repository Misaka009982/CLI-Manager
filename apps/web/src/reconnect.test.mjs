import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { createHistoryRefresh } from "./historyRefresh.ts";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText)}`;
const eventsUrl = moduleUrl(read("./fileOperationEvents.ts"));
const cacheUrl = moduleUrl(read("./projectDirectoryCache.ts"));
const { subscribeFileOperation } = await import(eventsUrl);
const { directoryScope, projectDirectoryCache } = await import(cacheUrl);
const { connectBrowserSocket } = await import(moduleUrl(read("./webClient.ts")
  .replace('"./fileOperationEvents"', JSON.stringify(eventsUrl))
  .replace('"./projectDirectoryCache"', JSON.stringify(cacheUrl))));

test("10,000 replay invalidations share one fetch and at most one follow-up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flights = [];
  const refresh = createHistoryRefresh((deviceId, signal) => new Promise((resolve) => flights.push({ deviceId, signal, resolve })));
  const first = refresh.refresh("device-a");
  for (let i = 0; i < 10_000; i++) assert.equal(refresh.refresh("device-a"), first);
  t.mock.timers.tick(150);
  assert.equal(flights.length, 1);
  const trailing = refresh.refresh("device-a");
  for (let i = 0; i < 10_000; i++) assert.equal(refresh.refresh("device-a"), trailing);
  t.mock.timers.tick(10_000);
  assert.equal(flights.length, 1, "never overlap a slow HTTP request");
  flights[0].resolve();
  await first;
  t.mock.timers.tick(150);
  assert.equal(flights.length, 2);
  flights[1].resolve();
  await trailing;
  t.mock.timers.tick(10_000);
  assert.equal(flights.length, 2);
});

test("logout cancels active and queued refreshes; a new login can refresh", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flights = [];
  const refresh = createHistoryRefresh((deviceId, signal) => new Promise((resolve) => {
    flights.push({ deviceId, signal, resolve });
    signal.addEventListener("abort", resolve);
  }));
  const active = refresh.refresh("device-a");
  t.mock.timers.tick(150);
  const pending = refresh.refresh("device-a");
  refresh.cancel();
  await Promise.all([active, pending]);
  assert.equal(flights[0].signal.aborted, true);
  const next = refresh.refresh("device-b");
  t.mock.timers.tick(150);
  assert.equal(flights.length, 2);
  assert.equal(flights[1].deviceId, "device-b");
  flights[1].resolve();
  await next;
});

function browser(t) {
  const timers = new Map();
  let timerId = 0;
  const win = new EventTarget();
  win.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  win.clearTimeout = (id) => timers.delete(id);
  const doc = new EventTarget();
  doc.visibilityState = "visible";
  const sockets = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    constructor(url) { this.url = url; sockets.push(this); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
    send() {}
    ready() { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: '{"type":"ready","latestSequence":0}' }); }
  }
  const restore = [];
  for (const [key, value] of Object.entries({ window: win, document: doc, location: { protocol: "http:", host: "127.0.0.1:9090" }, WebSocket: Socket })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    restore.push(() => old ? Object.defineProperty(globalThis, key, old) : delete globalThis[key]);
  }
  const runTimer = (delay) => {
    const found = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(found, `expected a ${delay}ms timer`);
    timers.delete(found[0]); found[1].callback();
  };
  const states = [], messages = [];
  let unauthorized = 0;
  const connection = connectBrowserSocket({ afterSequence: () => 42, onState: (value) => states.push(value), onMessage: (value) => messages.push(value), onUnauthorized: () => unauthorized++ });
  t.after(() => { connection.close(); restore.forEach((reset) => reset()); });
  return { sockets, timers, states, messages, connection, win, runTimer, unauthorized: () => unauthorized };
}

test("stalled handshake retries; disconnect and resume retire old socket callbacks", (t) => {
  const b = browser(t);
  const oldOpen = b.sockets[0].onopen;
  const oldMessage = b.sockets[0].onmessage;
  b.runTimer(10_000);
  b.runTimer(1_000);
  assert.equal(b.sockets.length, 2);
  b.sockets[1].ready();
  oldOpen(); oldMessage({ data: '{"type":"error","code":"stale"}' });
  assert.equal(b.messages.length, 1);
  assert.equal(b.states.at(-1), "open");
  b.sockets[1].onclose({ code: 1006 });
  b.runTimer(1_000);
  b.sockets[2].ready();
  b.win.dispatchEvent(new Event("online"));
  assert.equal(b.sockets.length, 4);
  assert.equal(b.sockets[2].onmessage, null);
  b.connection.close();
  assert.equal(b.timers.size, 0);
  b.win.dispatchEvent(new Event("pageshow"));
  assert.equal(b.sockets.length, 4);
});

test("an open socket without ready times out and authorization failure stops retry", (t) => {
  const b = browser(t);
  b.sockets[0].onopen();
  b.runTimer(10_000);
  b.runTimer(1_000);
  b.sockets[1].onclose({ code: 4401 });
  assert.equal(b.unauthorized(), 1);
  assert.equal(b.timers.size, 0);
  b.win.dispatchEvent(new Event("online"));
  assert.equal(b.sockets.length, 2);
});

test("heartbeat keeps idle connection alive; missing traffic reconnects a half-open socket", (t) => {
  const b = browser(t);
  b.sockets[0].ready();
  const oldTimer = [...b.timers.keys()][0];
  b.sockets[0].onmessage({ data: '{"type":"heartbeat"}' });
  assert.equal(b.timers.has(oldTimer), false);
  assert.equal(b.messages.length, 1, "transport heartbeat does not enter app state");
  b.runTimer(45_000);
  assert.equal(b.sockets[0].onmessage, null);
  b.runTimer(1_000);
  assert.equal(b.sockets.length, 2);
  assert.ok(b.sockets[1].url.endsWith("afterSequence=42"));
});

test("active socket publishes completion before app handling; stale socket cannot complete reads", (t) => {
  const b = browser(t);
  const operation = { idempotencyKey: "request", deviceId: "d", kind: "file.list", status: "succeeded", result: [] };
  const frame = { data: JSON.stringify({ type: "event", sequence: 43, payload: { type: "operation.updated", operation } }) };
  const received = [];
  const unsubscribe = subscribeFileOperation("request", "d", "file.list", (value) => received.push(value));
  t.after(unsubscribe);
  const stale = b.sockets[0].onmessage;
  b.win.dispatchEvent(new Event("online"));
  stale(frame);
  assert.equal(received.length, 0);
  b.sockets[1].ready();
  b.sockets[1].onmessage(frame);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].result, []);
  assert.equal(b.messages.at(-1).payload.operation.idempotencyKey, "request");
});

test("ready invalidates cache; replay offline events cannot clear current data; live offline and close clear it", (t) => {
  const b = browser(t);
  const scope = directoryScope("d", { projectId: "p", cwd: "C:/p" });
  const populate = () => projectDirectoryCache.put(scope, "", [], projectDirectoryCache.version);
  const send = (frame) => b.sockets[0].onmessage({ data: JSON.stringify(frame) });
  populate();
  send({ type: "ready", latestSequence: 42 });
  assert.equal(projectDirectoryCache.get(scope, "").fresh, false);
  populate();
  const payload = { type: "device.updated", device: { id: "d", status: "offline" } };
  send({ type: "event", sequence: 41, payload });
  assert.equal(projectDirectoryCache.get(scope, "").fresh, true);
  send({ type: "event", sequence: 43, payload });
  assert.equal(projectDirectoryCache.get(scope, ""), undefined);
  populate(); b.connection.close();
  assert.equal(projectDirectoryCache.get(scope, ""), undefined);
});
