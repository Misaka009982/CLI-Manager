import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const sidebar = read("../src/components/files/FileExplorerSidebar.tsx");
const formatter = read("../src/lib/aiPathFormatter.ts");
const drag = read("../src/lib/terminalFileDrag.ts");
const terminalInput = read("../src/hooks/useTerminalInput.ts");

test("file menus expose relative and absolute path copy actions", () => {
  assert.match(sidebar, /function FilePathCopyMenuItems/);
  assert.match(sidebar, /formatRelativeProjectFilePath\(path, kind\)/);
  assert.match(sidebar, /formatAbsoluteProjectFilePath\(project, path, kind\)/);
  assert.equal((sidebar.match(/<FilePathCopyMenuItems /g) ?? []).length, 3);
});

test("absolute file paths use the local root or SSH remote root", () => {
  assert.match(formatter, /project\.environment_type === "ssh" \? project\.remote_path : project\.path/);
  assert.ok(formatter.includes("normalizedPath.replace(/\\//g, separator)"));
});

test("file drags carry source context and absolute fallback data", () => {
  assert.match(drag, /export const TERMINAL_FILE_DRAG_MIME/);
  assert.match(drag, /absolutePath: formatAbsoluteProjectFilePath\(project, relativePath, kind\)/);
  assert.match(drag, /zone\.paste\(currentDrag\)/);
  assert.match(sidebar, /event\.dataTransfer\.setData\(TERMINAL_FILE_DRAG_MIME, JSON\.stringify\(payload\)\)/);
});

test("terminal drops choose relative text only for the same project location", () => {
  assert.match(terminalInput, /isSameProjectFileLocation\(payload\.source, targetProject\)/);
  assert.match(terminalInput, /payload\.absolutePath \|\| payload\.text/);
  assert.match(terminalInput, /projectWithWorktreePath\(project, worktree\)/);
  assert.match(terminalInput, /parseTerminalFileDragPayload\(event\.dataTransfer\?\.getData\(TERMINAL_FILE_DRAG_MIME\)\)/);
});
