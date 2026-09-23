import test from "node:test";
import assert from "node:assert/strict";
import { getClipboardImageFile, createClipboardPngFile, CLIPBOARD_IMAGE_MAX_BYTES } from "../src/features/terminal/lib/terminalClipboardImage.ts";
import { readTerminalClipboard } from "../src/features/terminal/lib/terminalClipboardRead.ts";

test("recognizes empty MIME and files-only image candidates while ignoring ordinary files", () => {
  const png = new File(["fixture"], "截图.PNG");
  assert.equal(getClipboardImageFile({ items: [], files: [png] }), png);
  assert.equal(getClipboardImageFile({ items: [{ kind: "file", type: "", getAsFile: () => png }], files: [] }), png);
  assert.equal(getClipboardImageFile({ items: [], files: [new File(["x"], "notes.txt")] }), null);
  assert.equal(getClipboardImageFile(null), null);
  const tiff = new File(["tiff"], "capture.tiff", { type: "application/octet-stream" });
  assert.equal(getClipboardImageFile({ items: [], files: [tiff] }), tiff);
});

test("known MIME does not require a filename extension and duplicate exposure yields one candidate", () => {
  const png = new File(["fixture"], "", { type: "image/png" });
  assert.equal(getClipboardImageFile({ items: [{ kind: "file", type: "image/png", getAsFile: () => png }], files: [png] }), png);
});

test("8K and 40MP pass the dimension gate; larger images fail before allocation", async () => {
  assert.equal(CLIPBOARD_IMAGE_MAX_BYTES, 20 * 1024 * 1024);
  for (const [width, height] of [[7680, 4320], [8000, 5000]]) {
    await assert.rejects(createClipboardPngFile(new Uint8Array(), width, height), /rgba_length_invalid/);
  }
  await assert.rejects(createClipboardPngFile(new Uint8Array(), 8000, 5001), /dimensions_too_large/);
});

const empty = { paths: [], hadFiles: false, rejectedCount: 0 };
function reader(overrides = {}) {
  const calls = [];
  return { calls, value: {
    files: async () => { calls.push("files"); return []; },
    images: async () => { calls.push("images"); return empty; },
    text: async () => { calls.push("text"); return "hello"; },
    ...overrides,
  } };
}

test("ordinary copied file paths keep priority and text-only clipboard still works", async () => {
  const files = reader({ files: async () => ["C:/file.txt"] });
  assert.deepEqual(await readTerminalClipboard(files.value), { kind: "paths", paths: ["C:/file.txt"] });
  assert.deepEqual(files.calls, []);
  const text = reader();
  assert.deepEqual(await readTerminalClipboard(text.value), { kind: "text", text: "hello" });
  assert.deepEqual(text.calls, ["files", "images", "text"]);
});

test("native screenshot paths win over text and image-only mode bypasses ordinary files", async () => {
  const screenshot = reader({ images: async () => ({ ...empty, paths: ["C:/attachments/clipboard.png"] }) });
  assert.equal((await readTerminalClipboard(screenshot.value)).kind, "paths");
  assert.deepEqual(screenshot.calls, ["files"]);
  screenshot.calls.length = 0;
  assert.equal((await readTerminalClipboard(screenshot.value, true)).kind, "paths");
  assert.deepEqual(screenshot.calls, []);
});

test("native read, lock, decode and limit errors never silently fall through to text", async () => {
  for (const code of ["clipboard_busy", "clipboard_image_read_failed", "clipboard_image_unsupported", "clipboard_image_too_large"]) {
    const source = reader({ images: async () => { throw new Error(code); } });
    await assert.rejects(readTerminalClipboard(source.value), new RegExp(code));
    assert.deepEqual(source.calls, ["files"]);
  }
  const rejected = reader({ images: async () => ({ ...empty, hadFiles: true, rejectedCount: 1, rejectionCode: "clipboard_image_too_large" }) });
  await assert.rejects(readTerminalClipboard(rejected.value), /clipboard_image_too_large/);
  await assert.rejects(readTerminalClipboard(reader().value, true), /clipboard_image_unsupported/);
});
