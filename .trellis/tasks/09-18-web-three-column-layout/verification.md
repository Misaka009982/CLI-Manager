# Web three-column layout

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
