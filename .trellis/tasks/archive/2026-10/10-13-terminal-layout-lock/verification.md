# Verification and delivery — V1.4.4 / #278

## Results
- `npx tsc --noEmit`: passed.
- `npm run check:architecture -- --strict`: passed, 1303 source files, zero violations.
- `git diff --check`: passed (only existing CRLF normalization notice).
- 81 tests passed across terminalLayoutLock, terminalWorkspan, terminalSplitLayout, workspanTabBarLayout, dragInteraction, workspaceLayoutState, workspaceLayoutControls, terminalPaneMarker, terminalSidePanelLayout.
- New behavior tests execute actual store actions, pointer observation, lock UI entry points and divider handlers. Async cancellation closes the newly-created PTY and releases both snapshots without touching the original session.
- GitNexus impact could not resolve the TSX/store functions (UNKNOWN). detect_changes returned low risk but failed to map most frontend implementation symbols, so its zero affected-flow result is not used as safety evidence. Source-reference inspection and behavior tests are the evidence.

## Discovery list
- Settings defaults/load/persistence + syncSettings exhaustive backup classification: added local-only lock preference.
- SortableTab / SortableWorkspanTab: disabled drag, observe intentional drag only, retain tab activation/close/rename accessibility.
- WorkspanTabBar / PaneTabBar: context menus and one visible lock indicator; top-strip hidden fallback keeps local tabs accessible.
- Controller / drag overlay: split-picker guard, drop guard, cancel hover/preview state on lock, suppress locked overlay.
- SplitTerminalView: block and rollback divider previews, clean listeners/RAF/cursor.
- terminalStore: guard 11 user layout actions, recheck asynchronous split before commit, reuse PTY/snapshot cleanup.
- Command palette / sidebar / split-picker callers: checked; shared store guards cover actual mutations, no duplicate implementation required.
- Normal create/close/restore and PTY runtime: intentionally allowed; no IPC or Rust contract changes.
- Workspan-mode configuration, project-tree drag, file drag, provider reorder, sidebar sizing: intentionally outside terminal gesture lock.

## Manual desktop acceptance (not run by agent)
1. In zh-CN and en-US, right-click a top-level tab, Pane tab, and tab-strip whitespace. Original menu actions must remain present; toggle text and toast must match the language.
2. Unlocked: no lock marker. Locked: one visible small lock at the strip end. Check top/bottom/hidden Workspan strip, Workspan off, single/multiple/nested panes and fullscreen; current Pane supplies the marker when no top strip is visible.
3. Clicking tabs switches without notifications. Deliberate tab drag shows one notification with Unlock and never changes order, panes or Workspans. Close/rename/input/scroll/new normal tab remain usable.
4. Try split/unsplit from menu, sidebar and command-palette/shortcut entry points, plus detach/merge and divider dragging. All layout operations should be blocked until unlocked.
5. Unlock through marker, menu and toast; operations resume. Lock while a divider is moving or while async split creates a PTY: preview rolls back/no extra session appears.
6. Switch projects/scopes and restart: local lock setting persists. Check local, WSL, SSH and Worktree sessions where available. Clock remains 24-hour in both languages.
7. Check normal/fullscreen fill and existing terminal background modes; no unintended outer gaps or terminal remount/output loss.

## Proposed work commit
`feat(terminal): 支持终端布局锁定 (#278)`

- `.trellis/spec/frontend/state-management.md`
- `CHANGELOG.md`
- `docs/功能清单.md`
- `src/features/sync/lib/syncSettings.ts`
- `src/features/terminal/components/PaneTabBar.tsx`
- `src/features/terminal/components/SortableTerminalTabs.tsx`
- `src/features/terminal/components/SplitTerminalView.tsx`
- `src/features/terminal/components/TerminalTabDragOverlay.tsx`
- `src/features/terminal/hooks/useTerminalTabsController.tsx`
- `src/features/terminal/store/terminalStore.ts`
- `src/features/workspace/api/WorkspanTabBar.tsx`
- `src/shared/i18n/messages/terminal.en-US.ts`
- `src/shared/i18n/messages/terminal.zh-CN.ts`
- `src/shared/preferences/settingsStore.ts`
- `scripts/terminalLayoutLock.test.mjs`
- `src/features/terminal/api/TerminalLayoutLockControls.tsx`
- `src/features/terminal/api/terminalLayoutLock.ts`
- `src/features/terminal/hooks/useLockedLayoutDrag.ts`
- `src/features/terminal/lib/lockedLayoutDrag.ts`

Excluded existing edits: `README.md`, `README.en-US.md`, `README.zh-CN.md`. No push. Task archive/journal bookkeeping follows the repository workflow after work commit approval.

## 2026-10-13 acceptance feedback follow-up
- Reused terminal tab-control styling for the lock indicator. Following the latest feedback, the lock toast/action retain the default application notification styling.
- Tab triggers stop context-menu bubbling; the whitespace trigger excludes tab/workspan targets. Lock/unlock menu items are text-only.
- `node --test scripts/terminalLayoutLock.test.mjs`: 24 passed.
- `node --test scripts/terminalLayoutLock.browser.test.mjs`: 3 passed (parent plus menu/theme subtests), using actual Radix/DnD/production tabs and styles with isolated desktop persistence. Covers zh-CN/en-US, locking via the real context menu, complete tab-menu item lists, whitespace menu and app/terminal light/dark combinations including the absence of toast/action theme overrides.
- `npx tsc --noEmit`, `npm run check:architecture -- --strict` (1306 files), and `git diff --check`: passed.
- The original missing-menu condition was not reproduced in the isolated fixture before event ownership was hardened; real desktop acceptance remains necessary. Initial browser assertions did detect menu icons and mismatched theme styles before those fixes.
- Manual follow-up: reproduce the screenshot scenario; verify the lock matches the terminal and the toast retains the default application notification styling, every original tab menu entry remains after locking, and lock/unlock entries contain no icon.

Additional proposed commit files:
- `scripts/terminalLayoutLock.browser.test.mjs`
- `scripts/fixtures/terminalLayoutLock.html`
- `scripts/fixtures/terminalLayoutLock.tsx`
- `scripts/fixtures/terminalLayoutLockStore.ts`

## 2026-10-13 toast styling correction
- Removed terminal theme lookup and toast/action style overrides; notifications use application defaults. Lock indicator and context-menu fixes remain.
- Re-ran combined unit/browser tests: 27 passed. TypeScript, strict architecture (1306 files, zero violations), and diff whitespace checks passed. Desktop visual verification was not run.

## User acceptance and commit
- User confirmed validation complete and authorized committing with Issue #278 association.
- Work commit: `8d500f01`, `feat(terminal): 支持终端布局锁定 (#278)`, body `Fixes #278`.
- Pre-commit staged diff check passed. GitNexus reported low risk but mapped only Settings; this limited result is not used as complete impact evidence. No code changes since the passing checks above.
- Existing README edits remain excluded. No push performed.
