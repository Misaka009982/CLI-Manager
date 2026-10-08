import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText)}`;
const requestIdUrl = moduleUrl(read("../apps/web/src/requestId.ts"));
const eventsUrl = moduleUrl(read("../apps/web/src/fileOperationEvents.ts"));
const cacheUrl = moduleUrl(read("../apps/web/src/projectDirectoryCache.ts"));
const clientUrl = moduleUrl(read("../apps/web/src/webClient.ts")
  .replace('"./fileOperationEvents"', JSON.stringify(eventsUrl))
  .replace('"./projectDirectoryCache"', JSON.stringify(cacheUrl)));
const filesUrl = moduleUrl(
  read("../apps/web/src/projectFiles.ts").replace('"./requestId"', JSON.stringify(requestIdUrl))
    .replace('"./webClient"', JSON.stringify(clientUrl))
    .replace('"./fileOperationEvents"', JSON.stringify(eventsUrl)),
);
const { readProjectFiles, readProjectOperation, parseFileEntries, parseFilePreview } = await import(filesUrl);
const { publishFileOperation } = await import(eventsUrl);
const { createDirectoryCache, directoryScope, projectDirectoryCache } = await import(cacheUrl);
const { createProjectDirectorySession } = await import(moduleUrl(read("../apps/web/src/projectDirectorySession.ts")
  .replace('"./projectFiles"', JSON.stringify(filesUrl))
  .replace('"./projectDirectoryCache"', JSON.stringify(cacheUrl))));
const { webClient } = await import(clientUrl);
const { sidebarLayout } = await import(moduleUrl(read("../apps/web/src/fileSidebarLayout.ts")));
const context = { key: "p:w", projectId: "p", worktreeId: "w", cwd: "C:/work" };

test("submit once, poll same operation, freeze project and Worktree identity", async () => {
  const selected = { ...context };
  const calls = [];
  const client = {
    async createOperation(input, signal) {
      calls.push(input); assert.ok(signal instanceof AbortSignal);
      selected.projectId = "other"; selected.worktreeId = "other";
      return { operation: { id: "one", status: "running" } };
    },
    async operation(id, signal) {
      calls.push(id); assert.ok(signal instanceof AbortSignal);
      return { operation: { id, status: "succeeded", result: [{ name: "a" }] } };
    },
  };
  assert.deepEqual(await readProjectFiles("device", selected, "file.list", "src", new AbortController().signal, client), [{ name: "a" }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], "one");
  assert.deepEqual(calls[0].payload, { projectId: "p", worktreeId: "w", path: "src" });
  assert.equal(calls[0].deviceId, "device");
});

test("only allow read kinds and require a registered project", async () => {
  const client = { createOperation() { assert.fail("must not submit"); } };
  await assert.rejects(readProjectFiles("d", context, "file.write_text", "x", new AbortController().signal, client), /unsupported/);
  await assert.rejects(readProjectFiles("d", {}, "file.list", "", new AbortController().signal, client), /project_not_found/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readProjectFiles("d", context, "file.list", "", controller.signal, client), { name: "AbortError" });
});

test("search payload uses query; terminal failures never resubmit", async () => {
  for (const status of ["failed", "rejected", "timed_out", "canceled"]) {
    let submits = 0;
    const client = { async createOperation(input) {
      submits++; assert.equal(input.payload.query, "readme"); assert.equal(input.payload.path, undefined);
      return { operation: { status, error: { code: "denied" } } };
    } };
    await assert.rejects(readProjectFiles("d", context, "file.search", "readme", new AbortController().signal, client), /denied/);
    assert.equal(submits, 1);
  }
});

test("abort or timeout cancels pending polling without another submission", async () => {
  for (const abort of [true, false]) {
    const controller = new AbortController();
    const client = {
      async createOperation() { return { operation: { id: "one", status: "running" } }; },
      operation() { assert.fail("must not poll after abort"); },
    };
    const timer = setTimeout(() => { if (abort) controller.abort(); }, 10);
    // Keep Node alive while the browser's timeout signal is pending.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(readProjectFiles("d", context, "file.list", "", controller.signal, client, 30),
        { name: abort ? "AbortError" : "TimeoutError" });
    } finally { clearTimeout(timer); clearTimeout(keepAlive); }
  }
});

test("file entries sort folders first and hide .git for directories AND Worktree files", () => {
  assert.deepEqual(parseFileEntries([
    { name: "z", path: "z", kind: "file" }, { name: "src", path: "src", kind: "directory" },
    { name: ".git", path: ".git", kind: "file" }, { name: ".git", path: "nested/.git", kind: "directory" },
  ]).map((item) => item.name), ["src", "z"]);
  assert.throws(() => parseFileEntries({}), /invalid/);
  assert.throws(() => parseFileEntries([{ name: "x" }]), /invalid/);
});

test("preview preserves literal text and rejects non-image or malformed payloads", () => {
  assert.equal(parseFilePreview({ content: "<script>unsafe</script>" }, false), "<script>unsafe</script>");
  assert.equal(parseFilePreview({ mimeType: "image/png", dataBase64: "YQ==" }, true), "data:image/png;base64,YQ==");
  assert.throws(() => parseFilePreview({ mimeType: "text/html", dataBase64: "YQ==" }, true), /invalid/);
  assert.throws(() => parseFilePreview({ mimeType: "image/png", dataBase64: "bad:url" }, true), /invalid/);
});

test("desktop widths are user-sized, not canvas blank-space dependent", () => {
  const layout = sidebarLayout(1920, 350, 520, true, true);
  assert.equal(layout.projects, 350);
  assert.equal(layout.files, 520);
  assert.equal(layout.desktop, true);
  assert.equal(sidebarLayout(1920, 250, 280, true, false).files, 0);
  assert.equal(sidebarLayout(1920, 250, 280, false, true).projects, 0);
  assert.equal(sidebarLayout(390, 250, 280, true, true).desktop, false);
  assert.equal(sidebarLayout(767, 250, 280, true, true).files, 0);
});

test("all sidebar combinations reserve terminal space including device details", () => {
  for (const left of [true, false]) for (const right of [true, false]) for (const details of [true, false]) {
    for (let viewport = 768; viewport <= 2560; viewport += 7) {
      const layout = sidebarLayout(viewport, 640, 640, left, right, details);
      assert.ok(layout.projects >= (left ? 200 : 0) && layout.projects <= 640);
      assert.ok(layout.files >= (right ? 200 : 0) && layout.files <= 640);
      const used = layout.projects + layout.files + layout.details + (Number(left) + Number(right)) * 6;
      assert.ok(viewport - used >= 320, `terminal too narrow at ${viewport}`);
      if (left) assert.ok(layout.projectMax >= layout.projects);
      if (right) assert.ok(layout.fileMax >= layout.files);
    }
  }
  const narrow = sidebarLayout(768, 500, 600, true, true);
  assert.ok(narrow.files < 600);
  // Clamping a narrow viewport never overwrites the remembered preference.
  assert.equal(sidebarLayout(1920, 500, 600, true, true).files, 600);
});

test("Web columns keep terminals mounted and remove geometry-driven overlays", () => {
  const views = read("../apps/web/src/views.tsx");
  assert.ok(!views.includes("ManagementPanel"));
  assert.match(views, /ProjectInspector/);
  assert.match(read("../apps/web/src/ProjectInspector.tsx"), /ProjectFilesPanel/);
  assert.match(views, /setFilesOpen\(!fileLayout\.desktop/);
  assert.match(views, /setFilesOpen\(false\); setFileContext\(undefined\); \}, \[selectedDevice\?\.id\]\)/);
  assert.match(views, /onSubmitManagement/); // context menus still use the transport
  const css = read("../apps/web/src/projectFiles.css");
  assert.doesNotMatch(css, /position: absolute|has-files-dock/);
  assert.match(views, /gridTemplateColumns: columns/);
  assert.match(views, /side="projects"/);
  assert.match(views, /side="files"/);
  assert.ok(!css.includes(".web-terminal-stack {"));
  const panel = read("../apps/web/src/ProjectFilesPanel.tsx");
  assert.match(panel, /request.current\?\.abort/);
  assert.ok(!panel.includes("dangerouslySetInnerHTML"));
  assert.match(panel, /entries\.slice\(0, visibleCount\[path\] \?\? 200\)/);
  assert.match(panel, /loading.has\(entry.path\)/);
  assert.doesNotMatch(panel, /disabled=\{busy &&/);
  assert.match(panel, /useSyncExternalStore\(directorySession.subscribe, directorySession.getSnapshot\)/);
  const layout = read("../apps/web/src/useFileSidebarLayout.ts");
  assert.doesNotMatch(layout, /xterm-screen|scrollWidth|sessionId/);
  assert.match(layout, /localStorage.setItem/);
  const resize = read("../apps/web/src/SidebarResizeHandle.tsx");
  assert.match(resize, /setPointerCapture/);
  assert.match(resize, /onPointerCancel/);
  assert.match(resize, /onLostPointerCapture/);
  assert.match(resize, /ArrowLeft/);
  assert.match(panel, /getMaterialFileIcon/);
  assert.match(panel, /searchOpen &&/);
  assert.match(panel, /data-selected/);
  assert.match(views, /hideHeader/);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const entry = (name, kind = "file") => ({ name, path: name, kind });

test("completion event before POST response wins without polling and cancels the HTTP wait", async () => {
  let dispatchedSignal;
  const client = {
    createOperation(input, signal) {
      dispatchedSignal = signal;
      const result = Promise.withResolvers();
      signal.addEventListener("abort", () => result.reject(signal.reason), { once: true });
      publishFileOperation({ ...input, id: "fast", status: "succeeded", result: [entry("done")] });
      return result.promise;
    },
    operation() { assert.fail("event should finish before the polling delay"); },
  };
  assert.deepEqual(await readProjectFiles("d", context, "file.list", "", new AbortController().signal, client), [entry("done")]);
  assert.equal(dispatchedSignal.aborted, true);
});

test("notifications match device, kind and request; pending and old notifications cannot complete a read", async () => {
  let request;
  let completed = false;
  const client = {
    async createOperation(input) { request = input; return { operation: { id: "one", status: "running" } }; },
    operation() { assert.fail("expected event completion"); },
  };
  const result = readProjectFiles("d", context, "file.list", "", new AbortController().signal, client)
    .then((value) => { completed = true; return value; });
  for (const override of [{ deviceId: "other" }, { kind: "file.read_text" }, { idempotencyKey: "old" }, { status: "running" }]) {
    publishFileOperation({ ...request, status: "succeeded", result: [], ...override });
  }
  await flush();
  assert.equal(completed, false);
  publishFileOperation({ ...request, status: "succeeded", result: [entry("ok")] });
  assert.deepEqual(await result, [entry("ok")]);
});

test("event failures and canceled reads clean up without submitting another operation", async () => {
  for (const cancel of [false, true]) {
    let request;
    const controller = new AbortController();
    const client = {
      async createOperation(input) { request = input; return { operation: { id: "one", status: "running" } }; },
      operation() { assert.fail("must not poll after completion/cancellation"); },
    };
    const result = readProjectFiles("d", context, "file.list", "", controller.signal, client);
    if (cancel) controller.abort();
    else publishFileOperation({ ...request, status: "rejected", error: { code: "denied" } });
    await assert.rejects(result, cancel ? { name: "AbortError" } : /denied/);
    publishFileOperation({ ...request, status: "succeeded", result: [] });
  }
});

test("directory cache is scoped, expires, evicts by LRU and rejects late writes after reset", () => {
  let time = 0;
  const cache = createDirectoryCache({ now: () => time, freshMs: 10, maxAgeMs: 100, maxDirectories: 2 });
  const scope = directoryScope("d", context);
  cache.put(scope, "", [entry("root")], cache.version);
  cache.put(scope, "a", [entry("a")], cache.version);
  assert.equal(cache.get(scope, "").fresh, true); // touch root, making a the oldest
  cache.put(scope, "b", [entry("b")], cache.version);
  assert.equal(cache.get(scope, "a"), undefined);
  for (const other of [directoryScope("other", context), directoryScope("d", { ...context, projectId: "other" }),
    directoryScope("d", { ...context, worktreeId: "other" }), directoryScope("d", { ...context, cwd: "D:/other" })]) {
    assert.equal(cache.get(other, ""), undefined);
  }
  time = 15;
  assert.equal(cache.get(scope, "").fresh, false);
  time = 100;
  assert.equal(cache.get(scope, ""), undefined);
  const oldVersion = cache.version;
  cache.clear();
  cache.put(scope, "late", [entry("late")], oldVersion);
  assert.equal(cache.get(scope, "late"), undefined);
  const small = createDirectoryCache({ maxBytes: 300 });
  small.put(scope, "huge", [entry("x".repeat(1000))], small.version);
  assert.equal(small.get(scope, "huge"), undefined);
});

function directoryHarness(t, options = {}) {
  const flights = [];
  const cache = options.cache ?? createDirectoryCache();
  const reader = (deviceId, ctx, kind, path, signal) => new Promise((resolve, reject) => {
    flights.push({ deviceId, ctx, path, signal, resolve, reject });
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const session = createProjectDirectorySession("d", context, reader, cache);
  const unsubscribe = session.subscribe(() => {});
  t.after(() => { unsubscribe(); session.stop(); });
  return { session, flights, cache, reader };
}

test("default cache keeps stale directories for ten minutes, but fresh only for thirty seconds", () => {
  let now = 0;
  const cache = createDirectoryCache({ now: () => now });
  cache.put("scope", "dir", [entry("child")], cache.version);
  now = 29_999;
  assert.equal(cache.get("scope", "dir").fresh, true);
  now = 30_000;
  assert.equal(cache.get("scope", "dir").fresh, false);
  now = 599_999;
  assert.deepEqual(cache.get("scope", "dir").entries, [entry("child")]);
  now = 600_000;
  assert.equal(cache.get("scope", "dir"), undefined);
});

test("stale cache revalidation never shows spinner and failed refresh preserves content", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const cache = createDirectoryCache({ now: () => now });
  cache.put(directoryScope("d", context), "dir", [entry("old")], cache.version);
  now = 45_000;
  const { session, flights } = directoryHarness(t, { cache });
  session.load("dir");
  t.mock.timers.tick(500);
  assert.deepEqual(session.getSnapshot().directories.get("dir"), [entry("old")]);
  assert.equal(session.getSnapshot().loading.size, 0);
  flights[0].reject(new Error("offline"));
  await flush();
  assert.deepEqual(session.getSnapshot().directories.get("dir"), [entry("old")]);
  assert.equal(session.getSnapshot().errors.has("dir"), true);
});

test("intent prefetch is debounced, idle only, bounded, and canceled when leaving", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, flights } = directoryHarness(t);
  session.prefetch("ignored"); session.cancelPrefetch(); t.mock.timers.tick(200);
  assert.equal(flights.length, 0);
  session.load("root"); session.prefetch("busy"); t.mock.timers.tick(200);
  assert.equal(flights.length, 1);
  flights[0].resolve([]); await flush();
  for (let i = 0; i < 6; i++) {
    session.prefetch(`dir${i}`); t.mock.timers.tick(180);
    assert.equal(flights.at(-1).path, `dir${i}`);
    session.load(`dir${i}`); // User click reuses the inflight request.
    flights.at(-1).resolve([entry(`dir${i}/child`)]); await flush();
  }
  session.prefetch("over-limit"); t.mock.timers.tick(200);
  assert.equal(flights.length, 7);
  assert.ok(flights.every((flight) => !flight.path.endsWith("child")), "no recursive prefetch");
});

test("Git reader shares completion channel, freezes context and refuses write operations", async () => {
  const client = { async createOperation(input) {
    assert.deepEqual(input.payload, { repository: "nested", projectId: "p", worktreeId: "w" });
    publishFileOperation({ ...input, status: "succeeded", result: { commits: [], nextCursor: null } });
    return { operation: { id: "read", status: "running" } };
  }, operation() { assert.fail("completion event avoids polling"); } };
  const result = await readProjectOperation("d", context, "git.history",
    { repository: "nested", projectId: "evil", worktreeId: "evil", cwd: "C:/outside", rootPath: "C:/outside" },
    new AbortController().signal, client);
  assert.deepEqual(result, { commits: [], nextCursor: null });
  await assert.rejects(readProjectOperation("d", context, "git.push", {}, new AbortController().signal, client), /unsupported/);
});

test("prefetch stays silent but a slow promoted click gets foreground feedback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, flights } = directoryHarness(t);
  session.prefetch("folder");
  t.mock.timers.tick(180);
  t.mock.timers.tick(500);
  assert.equal(session.getSnapshot().loading.size, 0);
  session.load("folder");
  t.mock.timers.tick(150);
  assert.equal(session.getSnapshot().loading.has("folder"), true);
  assert.equal(flights.length, 1);
  flights[0].resolve([]); await flush();
  assert.equal(session.getSnapshot().loading.size, 0);
});

test("independent directory requests deduplicate and only run two at once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, flights } = directoryHarness(t);
  for (const path of ["a", "a", "b", "c"]) session.load(path);
  assert.deepEqual(flights.map((flight) => flight.path), ["a", "b"]);
  assert.deepEqual([...session.getSnapshot().pending], ["a", "b", "c"]);
  t.mock.timers.tick(149);
  assert.equal(session.getSnapshot().loading.size, 0);
  t.mock.timers.tick(1);
  assert.deepEqual([...session.getSnapshot().loading], ["a", "b", "c"]);
  flights[1].resolve([entry("b/child")]);
  await flush();
  assert.equal(flights[2].path, "c", "a slow directory does not block unrelated directories");
  assert.equal(session.getSnapshot().pending.has("b"), false);
  flights[0].reject(new Error("denied"));
  flights[2].resolve([]);
  await flush();
  assert.equal(session.getSnapshot().errors.has("a"), true);
  assert.deepEqual(session.getSnapshot().directories.get("c"), []);
  session.load("a");
  assert.equal(flights.length, 4);
  assert.equal(session.getSnapshot().errors.has("a"), false);
});

test("completed directory cache survives remount; stale entries render while refreshing", async (t) => {
  let now = 0;
  const cache = createDirectoryCache({ now: () => now, freshMs: 10, maxAgeMs: 100 });
  const first = directoryHarness(t, { cache });
  first.session.load("");
  first.flights[0].resolve([entry("old")]);
  await flush();
  first.session.stop();
  const next = directoryHarness(t, { cache });
  assert.deepEqual(next.session.getSnapshot().directories.get(""), [entry("old")]);
  next.session.load("");
  assert.equal(next.flights.length, 0);
  now = 15;
  next.session.load("");
  assert.equal(next.flights.length, 1);
  assert.deepEqual(next.session.getSnapshot().directories.get(""), [entry("old")]);
  next.flights[0].resolve([entry("new")]);
  await flush();
  assert.deepEqual(next.session.getSnapshot().directories.get(""), [entry("new")]);
});

test("refresh and unmount cancel queued work; late replies cannot replace refreshed data", async (t) => {
  const { session, flights, cache } = directoryHarness(t);
  for (const path of ["", "slow", "queued"]) session.load(path);
  session.refresh();
  await flush();
  assert.equal(flights[0].signal.aborted, true);
  assert.equal(flights[1].signal.aborted, true);
  assert.equal(flights.some((flight) => flight.path === "queued"), false);
  assert.equal(flights[2].path, "");
  flights[2].resolve([entry("new")]);
  flights[0].resolve([entry("old")]);
  await flush();
  assert.deepEqual(session.getSnapshot().directories.get(""), [entry("new")]);
  session.load("pending"); session.stop();
  await flush();
  assert.equal(session.getSnapshot().pending.size, 0);
  assert.equal(cache.get(directoryScope("d", context), "pending"), undefined);
});

test("reconnect revalidates mounted trees; auth/device clearing aborts and removes visible cached data", async (t) => {
  const { session, flights, cache } = directoryHarness(t);
  session.load(""); flights[0].resolve([entry("old")]);
  await flush();
  cache.invalidate();
  assert.equal(flights.length, 2);
  assert.deepEqual(session.getSnapshot().directories.get(""), [entry("old")]);
  cache.clearDevice("unrelated");
  assert.equal(flights[1].signal.aborted, false);
  cache.clearDevice("d");
  assert.equal(flights[1].signal.aborted, true);
  assert.equal(session.getSnapshot().directories.size, 0);
  await flush();
  assert.equal(flights.length, 2, "cache clearing must not initiate reads during logout/offline");
});

test("401 clears cache and keeps session-expired feedback instead of an empty directory", async (t) => {
  projectDirectoryCache.clear();
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 401,
    json: async () => ({ error: { code: "unauthorized", message: "unauthorized" } }) }));
  const session = createProjectDirectorySession("d", context);
  const unsubscribe = session.subscribe(() => {});
  t.after(() => { unsubscribe(); session.stop(); projectDirectoryCache.clear(); });
  session.load("");
  await flush();
  assert.equal(session.getSnapshot().directories.size, 0);
  assert.equal(session.getSnapshot().pending.size, 0);
  assert.equal(session.getSnapshot().errors.get("").message, "session_expired");
});

test("logout clears retained data even on failure; successful device removal clears only its cache", async (t) => {
  projectDirectoryCache.clear();
  t.after(() => projectDirectoryCache.clear());
  const scope = directoryScope("d", context), other = directoryScope("other", context);
  const populate = () => {
    projectDirectoryCache.put(scope, "", [entry("a")], projectDirectoryCache.version);
    projectDirectoryCache.put(other, "", [entry("b")], projectDirectoryCache.version);
  };
  const mock = t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ ok: true }) }));
  populate();
  await webClient.removeDevice("d");
  assert.equal(projectDirectoryCache.get(scope, ""), undefined);
  assert.ok(projectDirectoryCache.get(other, ""));
  populate();
  mock.mock.mockImplementation(async () => { throw new Error("offline"); });
  await assert.rejects(webClient.removeDevice("d"), /offline/);
  assert.ok(projectDirectoryCache.get(scope, ""), "failed removal must not clear valid data");
  await assert.rejects(webClient.logout(), /offline/);
  assert.equal(projectDirectoryCache.get(scope, ""), undefined);
  assert.equal(projectDirectoryCache.get(other, ""), undefined);
});
