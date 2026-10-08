# Web three-column layout

## 2026-09-28 follow-up: Web file-tree completion, cache and independent loading

Packaging follow-up approved by user: rebuild Web assets and re-bundle NSIS 1.4.1 only.
The baseline difference `5887e8ac..64836f5e` is `CHANGELOG.md` only; the existing
2026-09-23 local Release binaries can be reused. Preserve the previous installer and
compare all four executable SHA256 hashes before/after bundling. Commit source before
packaging; record the final artifact after successful verification.

Packaging result (2026-09-28):

- Source committed before packaging as `e42f81ca`.
- Web build passed; ran `tauri bundle --bundles nsis --config src-tauri/tauri.local.conf.json --ci`
  with `CARGO_TARGET_DIR=src-tauri/target/local`. One NSIS bundle produced; no Cargo compile/MSI.
- Installer: `src-tauri/target/local/release/bundle/nsis/CLI-Manager_1.4.1_x64-setup.exe`,
  29,950,034 bytes, written 2026-09-28 16:51:58 +08:00.
- Installer SHA256: `D07B6148055312F03B3286CD23E1FEAFFE9B9658F5245855DF324F7E4283CFB8`.
- Generated NSIS manifest includes final `index-CYxBGQFY.js`, `index-DGGuWXPU.css` and
  matching `index.html`. All four local Release executable SHA256 hashes are unchanged
  after bundling (Tauri temporarily sets and then restores the main executable bundle marker).
- Old installer preserved alongside it as
  `CLI-Manager_1.4.1_x64-setup-before-web-file-loading-20260928.exe`.
- No installed app/service was started, stopped or modified; installer runtime acceptance
  remains manual. No remote push or branch merge performed.

User approved implementation on `fix/web-file-tree-loading`, created from freshly fetched
`origin/master` (`64836f5e`). Release notes remain 1.4.1. No installer, remote push or merge
was requested in this implementation turn.

Root cause: the browser awaited polling even though the existing operation WebSocket event
already contained the result; directory data lived only inside a remounted file panel and
one busy flag disabled unrelated entries. The change therefore lands in the Web read transport
and file-panel state owner, not in Rust directory enumeration or the spinner's appearance.

Discovery / impact review:

- `readProjectFiles`: subscribe before POST, match device/kind/idempotency key, race terminal
  events against polling and abort the losing transport. Polling uses the same operation ID,
  every 500ms initially / 1s after 3s; missing events never cause a second submission.
- `connectBrowserSocket` / `request`: publish from the active authenticated socket before app
  selection filtering, invalidate on ready, ignore replayed offline invalidations, clear on
  live offline/removal/logout/401/authorization close. HTTP 401 leaves explicit session-expired
  feedback rather than presenting an empty directory.
- `projectDirectoryCache`: memory-only LRU, 96 directories and approximate 4MiB string/object
  budget, fresh for 30s and discarded after 5min on access. Device/project/Worktree/cwd form
  the scope. An invalidation epoch prevents late writes after cache clearing.
- `projectDirectorySession` / `ProjectFilesPanel`: cache-backed external state, two active
  directory reads, per-path dedup/loading/errors, delayed 150ms spinner, local retry, stale
  contents retained during refresh. Unmount/refresh abort browser requests and clear queued
  work; completed reads cannot reopen a folder the user has collapsed.
- Server `handle_operation_update`: confirmed existing events include the stored result.
- Confirmed unrelated: desktop file explorer, Rust directory enumeration, SSH/WSL transport,
  PTY/session ownership, terminal sizing/input, hooks, authorization and file path validation.
  Web SSH browsing retains its existing unsupported feedback.
- GitNexus MCP is not exposed in this session; use the available codebase-memory index,
  current source, contracts, focused tests and Git diff as the required fallback. Pre-edit
  memory impact marked `connectBrowserSocket -> useAppModel` CRITICAL; this was reported
  before editing and is covered by the existing plus extended socket lifecycle tests.

Scenario matrix: first/cached/stale expansion; empty/failed/slow directory; burst clicks and
same-directory duplicates; close/reopen sidebar and project/Worktree/device changes;
collapse during a read; refresh/unmount/React effect cleanup while requests are pending;
completion before POST response; lost/replayed/wrong-identity notifications; reconnect,
offline, removal, logout and expired login. Desktop dock/mobile drawer share this code;
local and WSL paths retain backend validation. Window focus, split panes and hooks do not
change directory scope or backend execution.

Verification:

- `node --test scripts/webProjectFiles.test.mjs apps/web/src/reconnect.test.mjs`: 26 passed.
  Tests include actual fake-socket delivery/retirement, early completion, missed-event polling,
  auth failure, cross-scope isolation, TTL/LRU/size limit, two-read concurrency, retries,
  cancellation, stale-result rejection, remount reuse and mounted-tree invalidation.
- `npm run web:typecheck`: passed. `npm run web:build`: passed including TypeScript;
  existing Vite large-chunk warning remains. Built assets: `index-CYxBGQFY.js` / `index-DGGuWXPU.css`.
- `npm run check:architecture -- --strict`: 1177 source files, zero files above 2000 lines,
  zero violations. No dependencies or protocol fields added.
- Post-edit memory refresh returned `ready`, but a targeted search did not expose the three
  new, untracked modules; its change detector also listed only tracked edits. Treat the graph
  as incomplete, not proof of no impact. Current source, `git status` (including new files),
  TypeScript compilation and behavior tests are the final call-chain verification.
- Per project quality rules, no CLI-Manager/Tauri/Web service was launched for UI verification.
  Automated timings are not claimed as measured NetBird/disk performance.

Human acceptance: on PC and phone open an uncached folder, then two other folders rapidly;
close/reopen the sidebar and switch away/back to the same project within 30s; verify cached
expansion and independent controls. After 30s, change directory contents and expand again;
verify background update or use Refresh. Collapse while loading, switch Worktrees, simulate
disconnect/reconnect and logout/login; confirm no stale/foreign contents. Check existing
Chinese/English loading, refresh and expired-session feedback. First uncached reads and slow
disks/network still legitimately show loading. Revert the Web source commit and rebuild the
Web assets to roll back; no schema/config migration is required.

## 2026-09-20 follow-up: event-driven file operation pickup

The user approved reopening this Trellis task to remove the visible delay when expanding an uncached Web file-tree directory.

Root cause: the Rust Web device bridge already emitted `OPERATION_EVENT` as soon as the server delivered a management operation, but the React listener called the generic status-only `polling.wake()`. Operation execution therefore still waited for the independent one-second fallback timer. The fix lands in the shared bridge scheduler: operation events now request an immediate, non-overlapping drain, while the periodic drain remains as recovery protection.

Discovery list and implementation scope:

- Rust Web device queue: confirmed it already emits `OPERATION_EVENT` for every newly inserted operation; no protocol or daemon change required.
- Shared Web bridge polling: add event-driven operation wake-up, reconnect handoff and one coalesced follow-up when events arrive during a drain.
- Desktop Web bridge hook: route operation events to the dedicated operation wake-up; status events keep their existing status-only wake-up.
- Web project file tree: retain immediate busy/accessibility state, but delay the row spinner by 150 ms so fast reads do not flash.
- Periodic recovery: retain the one-second operation drain as a safety net for missed events.
- Confirmed unrelated: terminal command polling, PTY ownership and sizing, file-list IPC implementation, SSH directory transport, WSL path handling, project tree layout and desktop file explorer.

Scenario matrix: already-online and reconnecting bridges; single and burst operation events; event arrival during an in-flight drain; event loss with fallback polling; stop/unmount during pending work; first-time and cached folder expansion; local, WSL and slow/network-backed directories; desktop and mobile Web layouts. Slow directories continue to show feedback after the threshold, while cached directories keep their existing instant expansion.

Implementation verification before packaging:

- `node --test src/shared/lib/webBridgePolling.test.mjs`: 9 passed, including the desktop event binding, immediate event drain, pre-online event handoff, burst coalescing, non-overlap and periodic fallback.
- `node --test scripts/webProjectFiles.test.mjs`: 9 passed.
- Web and desktop TypeScript checks passed.
- `npm run check:architecture -- --strict`: 1155 source files, zero files above 2000 lines and zero violations.
- Web production build passed; Vite retains the existing large-chunk warning.
- GitNexus CLI cannot read the pre-existing unowned `.gitnexus` storage and reports that no code index database is present; GitNexus MCP tools are not exposed in this session. The required impact review therefore used the refreshed codebase-memory graph plus current source, tests and Git diff; the shared scheduler call surface was classified CRITICAL before editing.

Packaging results will be appended after the required pre-package commit and NSIS build.

## 2026-09-20 follow-up: proactive shared-terminal geometry sync

The user approved reopening this Trellis task for the Web terminal's stale initial geometry. This is a root-cause fix because the failure crosses desktop viewport ownership, Tauri IPC, daemon protocol, server relay and browser rendering.

Root cause: desktop-owned terminal geometry is only carried by output frames, so a silent desktop resize leaves the browser on stale columns/rows until the next model output; independently, legacy browser width/height preferences still constrain the terminal canvas and can preserve an obsolete partially-filled layout.

Discovery list and implementation scope:

- Desktop viewport ownership: expose the visible desktop terminal's current columns/rows.
- Desktop Web bridge: deduplicate and proactively publish geometry through the existing command-drain cadence.
- Tauri command / Web daemon / shared protocol / server relay: add optional, validated columns/rows to terminal status without breaking older peers.
- Browser state / workbench / WebTerminal: consume geometry status immediately and refresh the active xterm canvas without remounting it.
- Browser display preferences: remove the legacy width/height controls and migrate saved values to full available area.
- Confirmed unrelated: desktop visual layout, PTY process sizing ownership, WSL/SSH execution, hooks and file-tree data loading.

Scenario matrix: desktop-owned and Web-owned control; silent resize and resize followed by output; active/inactive tab and tab switching; one/multiple sessions and subagent split; wide/narrow desktop browser and mobile; old/new/missing display preferences; disconnected/reconnected device; local PowerShell/CMD/Pwsh, WSL and SSH. Geometry remains authoritative only for the visible desktop viewport; Web-owned sessions continue using browser sizing.

Verification results will be appended after implementation.

Implementation verification before packaging:

- Desktop viewport ownership and Web display/layout tests: 19 passed.
- Shared protocol terminal-status compatibility test: passed; optional geometry is camelCase and legacy frames still deserialize without it.
- WebSocket relay integration test: passed, including `controlMode`, `cols` and `rows` delivery to the browser.
- Desktop Web outbox library tests: 8 passed. The broader unfiltered Cargo test command remains blocked by the pre-existing `tests/web_listener.rs` fixture missing `Config.trusted_network`; the scoped library suite and `cargo check` pass.
- Web production build, Web typecheck, desktop TypeScript typecheck and all three Rust crate checks passed. Vite retains the existing large-chunk warning.
- Strict architecture check: 1155 source files, zero files above 2000 lines and zero violations.
- Codebase-memory index was refreshed and found the new geometry owner/bridge/browser symbols. Its change detector reported the expected 26 files and no additional impacted symbols.
- GitNexus CLI remains unavailable for impact/detect-changes because `.gitnexus` is in the pre-existing unowned state and has no code index database. Current source, scoped diffs, codebase-memory impact tracing, compilation and tests are the documented fallback evidence.

Packaging:

- Code was committed before packaging as `176ab366` (`fix(web): sync shared terminal geometry proactively`).
- `npm run tauri:build:local -- --bundles nsis` passed; only the NSIS bundle was requested and produced.
- Installer: `src-tauri/target/release/bundle/nsis/CLI-Manager_1.4.0_x64-setup.exe` (27,139,741 bytes; 2026-09-20 10:42:29 local).
- SHA256: `A59F795AF7436D67032B948EEF9FCDD72354F4F2E3D14E288C8968006094EEC7`.
- Final Web index references `index-B31MdRAM.js` and `index-C4qoI8Dp.css`; main, Web daemon, daemon and Codex proxy Release executables were rebuilt during the same bundle run.
- Previous installer preserved as `CLI-Manager_1.4.0_before-geometry-sync-20260920.exe`. No remote push or merge was performed.

User approved implementation and NSIS packaging. Installer version remains 1.4.0; release notes use TEMP.

## Cause and discovery

The Web sidebar used absolute positioning and measured spare terminal canvas width. It did not participate in workspace allocation, producing overlay behavior and geometry-driven visibility changes. Fix at the Web layout owner, not inside terminal rendering.

- Workbench / styles: replace overlay with normal-flow columns, explicit visibility and persistent resizable widths.
- File sidebar layout: remove canvas measurement and hysteresis; reserve terminal width, clamp both sidebars as viewport changes.
- ProjectFilesPanel: reuse Material icons, compact heading, toggle search, retain read-only lazy directory cache and cancellation.
- WebTerminal: remove unused layout-notification callback only; retain existing ResizeObserver and PTY ownership policy.
- Desktop terminal, backend API, WSL/SSH/hook execution: unchanged; unsupported file browsing continues to report capability errors.
- GitNexus unavailable (no indexed repositories; earlier index attempt failed on unowned storage). Memory search plus current source, contracts, references and Git diff are the fallback evidence.

## Scenarios / acceptance

Desktop both/one/no sidebars, narrow/wide viewport, device details open, remembered widths and collapse, keyboard/pointer resize, light/dark + zh/en; mobile drawer, touch rows, keyboard viewport; terminal tab switch, subagent split, desktop-owned/Web-owned PTY, offline/missing project/Worktree, explicit other-project menu target. No desktop services or UI will be launched by the agent per quality guidelines.

## Verification

- `node --test scripts/webProjectFiles.test.mjs`: 9 passed, including all sidebar visibility combinations across 768–2560px, device-details allocation, width preference restoration and mobile breakpoint.
- `npm run check:architecture -- --strict`: 1155 files, zero violations.
- Web typecheck + production build passed; existing large-chunk warning remains (Material icons are bundled locally, no CDN requests).
- Memory index refreshed and new resize handle found in the graph. GitNexus impact/detect-changes unavailable; scoped Git diff and source references used instead.
- Desktop `npx tsc --noEmit`, desktop production build, final Web build and full Rust Release build passed. Release compilation took 53m22s with the existing fat-LTO/single-codegen-unit profile.
- `npm run tauri:build:local -- --bundles nsis`: passed, one NSIS installer only. No app/server was launched, stopped or reconfigured for verification.
- Human visual validation required: drag/collapse both columns, switch tabs with subagents, resize browser, refresh width preferences, open mobile files/search/preview, check both languages/themes and shared PTY input/scroll behavior. These runtime checks are not claimed as tested by the agent.

## Package

- Code committed before packaging: `967ca0cf`; includes pairing fix parent `a0fedba3`.
- Installer: `src-tauri/target/release/bundle/nsis/CLI-Manager_1.4.0_x64-setup.exe` (27,139,853 bytes; 2026-09-18 17:55:57 local).
- SHA256: `F0F3312EA9EB08D76B486E7A7CC6375430A8805400E28B2D788E61A4F6EEF487`.
- NSIS manifest references final Web `index-C7wUYIVQ.js` / `index-Cy-65ZmT.css` plus freshly rebuilt main, daemon, Web daemon and Codex proxy executables.
- Old installer preserved as `CLI-Manager_1.4.0_before-three-columns-20260918.exe` in the same directory. No remote push or merge performed.
