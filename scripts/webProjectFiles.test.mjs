import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText)}`;
const requestIdUrl = moduleUrl(read("../apps/web/src/requestId.ts"));
const clientUrl = moduleUrl(read("../apps/web/src/webClient.ts"));
const { readProjectFiles, parseFileEntries, parseFilePreview } = await import(moduleUrl(
  read("../apps/web/src/projectFiles.ts").replace('"./requestId"', JSON.stringify(requestIdUrl))
    .replace('"./webClient"', JSON.stringify(clientUrl)),
));
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
  assert.match(views, /ProjectFilesPanel/);
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
  assert.match(panel, /setTimeout\(\(\) => \{[\s\S]*setLoadingPath\(path\);[\s\S]*\}, 150\)/);
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
