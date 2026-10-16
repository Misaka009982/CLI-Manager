# Validation — 2026-10-16

## Passed

- `node --test scripts/terminalUnicode.test.mjs scripts/terminalPiCompatibility.test.mjs scripts/terminalReflowPolicy.test.mjs scripts/terminalReplay.test.mjs scripts/terminalRemountSnapshot.test.mjs scripts/webTerminalLayout.test.mjs scripts/webTerminalInputFollow.test.mjs`: 66/66 passed, including eight new Unicode tests.
- `npx tsc --noEmit` and `npm run web:typecheck`: passed.
- `npm run build`: passed (Vite 1m55s); `npm run web:build`: passed (Vite 24s).
- Both builds report existing large-chunk warnings; no compilation errors. No Tauri binary packaging or desktop service startup was performed.
- `npm run check:architecture -- --strict`: 1340 source files, zero >2000 lines, zero new violations.
- Real Vite library builds of the shared module under desktop and Web roots: default selects graphemes, unicode11 environment override selects unicode11 (four cases passed).
- `git diff --check`: no whitespace errors; Git warns about normal LF→CRLF conversion for the updated existing test.

## Pi #285 verification

Used installed official Pi 1.2.0 ScrollView/renderLayoutFrame with a 20-column viewport and a final content marker R.
Auto receives width 20 and paints `XXXXXXXXXXXXXXXXXXX█`, losing R.
Always receives width 19 and paints `XXXXXXXXXXXXXXXXXXR█`, preserving R.
The diagnostic uses Node stripVTControlCharacters so OSC hyperlink resets are not mistaken for visible cells.

Local global settings at `~/.pi/agent/settings.json` changed only fullscreenScrollbar from absent/default auto to always.
Original bytes backed up alongside the file as `settings.json.before-issue285-2026-10-16T09-00-12-829Z.bak`.
All other JSON keys checked for deep equality; current repository has no project-level Pi settings override.
An already running Pi must apply the value through /settings or restart. No CLI-Manager startup behavior changes other users' configs.

## Review findings

- Updated two pre-existing stale source assertions in terminalPiCompatibility.test.mjs: current production transforms are wrapped in colorQueries.feed. Production filtering was not changed.
- Web initially lacked the Vite ImportMeta declaration for the shared module; a vite/client type reference resolved it, with subsequent typecheck and build passing.
- Upstream impact for each initialization entry is LOW; detect_changes labels aggregate HIGH because the large desktop entry belongs to nine execution paths. Only the two expected initialization symbols changed; reviewed query, replay and size ownership remain intact.
- Index freshness is imperfect after the earlier FTS refresh failure; new/untracked symbols are covered by manual diff review and actual tests, not assumed absent from the graph.
- No new product UI strings, API/DB schemas, PTY output rewriting, scrollbar CSS, fonts or unrelated dependencies changed.

## Upstream merge verification — 2026-10-16

- At the user's request, fetched origin and fast-forwarded master from f52b9bda to 7e16b4c3 (seven incoming commits, PR #284).
- Preserved all local changes through a temporary stash including untracked files. Only CHANGELOG.md conflicted; both V1.4.4 sections were retained. The spec index and feature inventory merged automatically.
- Compared restored tracked implementation with the stash and verified all 11 previously untracked files against their saved Git blobs. Only the expected upstream documentation additions differed.
- Re-ran the seven terminal suites listed above plus startupCommandMultiline, codexHookIsolation, deepseekTuiRuntime and resumeCliArgs: 144/144 passed.
- Desktop and Web typechecks passed; strict architecture check passed (1342 source files, zero over 2000 lines, zero violations). No unresolved paths or staged code changes remain.
- At this checkpoint the issue fixes remained uncommitted. No push or agent UI verification was performed.

## Human validation confirmed — 2026-10-16

The user reported "验证完成，可以提交代码了", confirming validation and authorizing the code commit.
They subsequently requested deletion of the standalone compatibility document; removed it and cleaned its links and the commit plan. No production code changed after the passing merge checks.
The list below records the manual checklist supplied to the user; the agent did not launch the application or independently claim pixel verification.

Per .trellis/spec/frontend/quality-guidelines.md, do not launch the application for agent UI verification.
Use new Pi/Claude/Codex sessions to verify emoji table pixels, editing/cursor/selection/IME,
DOM/WebGL and background-image modes, normal/fullscreen/split layouts, Web mirror/control and replay.
Verify Pi always keeps rightmost content visible and separately inspect scrollbar glyph continuity.
These pixel checks are not implied by the passing buffer tests; font fallback overdraw remains a separate issue.
