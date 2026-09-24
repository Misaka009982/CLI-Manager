# Verification

## Follow-up: adaptive 200–300px file dock

- Cause: the fixed 300px dock required 340px spare width to open, leaving narrower usable gaps empty. Geometry now permits opening at 240px and remaining open down to 224px; width is clamped to 200–300px after reserving 24px for inset/gap.
- Touchpoints: fileSidebarLayout geometry, useFileSidebarLayout measurement, Workbench CSS-variable binding, projectFiles dock and control offsets, targeted tests. Desktop/server/PTY sizing and file APIs are unchanged.
- Scenarios: opening/closing thresholds, fractional widths, 200/300px bounds, wide/narrow viewport, horizontal overflow, split pane, tab identity; existing hidden preference and mobile drawer preserved.
- GitNexus impact unavailable (no indexed repository); memory search plus actual source/reference search used instead. Memory index refreshed after changes.
- Validation: 19 targeted tests passed; Web typecheck/production build passed (existing large-chunk warning); strict architecture passed with zero violations; git diff --check passed. No app/dev server launched; browser visual acceptance remains manual. No installer packaging or remote push performed.

## Follow-up: model-menu scrolling and desktop sidebar collapse

- Root cause: all accepted PTY input armed cursor following, including Enter and navigation sequences; following intermediate cursor moves could reveal a TUI repaint cursor rather than the input caret.
- Changed WebTerminal input classification/parsed-output follow and cursor visibility tracking; added a small tested follow controller in terminalCursorView. Reset, manual scrolling and tab lifecycle cancel pending follow.
- Workbench adds a persistent desktop sidebar toggle; CSS hides only the direct desktop sidebar and releases its grid column, including with the details panel open. ProjectTree remains mounted; mobile drawer unaffected. New control labels are bilingual.
- Touchpoints confirmed unrelated: desktop source, Rust/server, shared PTY ownership/resize algorithm, project/file management APIs and mobile keyboard.
- 26 targeted tests passed, including simulated model-picker navigation/confirmation and Unicode typing/paste; Web typecheck and strict architecture passed. Actual browser/Safari interaction and manual language switching remain unperformed per project rules.
- GitNexus impact has no registered repositories; used memory references plus actual source/Git diff for scope verification. No application or dev service launched during this follow-up.

## Follow-up: dock and directory-response regression

- Root cause: `.xterm` fills available width even when `.xterm-screen` does not; the prior layout gate also rejected any vertical overflow. An explicit project drawer was also closed when project selection switched the terminal. File reads always waited at least 400 ms for polling and disabled the entire tree while pending.
- Touched: Web-only geometry/hook, dock entry, file read polling, file tree loading UI, scoped CSS and tests. Confirmed unrelated: desktop UI, Rust host file-list command, server operation transport, PTY resize/layout ownership, mobile toolbar and SSH.
- States: desktop with/without vertical scroll and with horizontal overflow, narrow mobile, subagent split, explicit different-project drawer, cached/unloaded folders, offline/missing Worktree all follow existing guards.
- A directory returned with hundreds of entries now initially renders 200, with a user-visible show-more control; native directory enumeration/transport limits are unchanged and can still dominate for extremely large directories.
- Follow-up verification: 27 targeted tests passed; Web typecheck/production build passed; strict architecture check passed with zero violations; no desktop, Rust or server production source changed.
- An unrelated terminal smoke script was accidentally invoked during validation and immediately stopped; no Vite/node process or port 5173 listener remained. No screenshot/browser end-to-end verification performed under project instructions.

- Web typecheck and production build passed.
- 27 targeted tests passed: file reads/polling/abort/timeout/context capture, preview validation, docking, existing terminal layout/font/clipboard/image bridge.
- Strict architecture: zero violations. git diff --check passed.
- No production changes under src/ or src-tauri/: desktop behavior, backend interfaces, terminal sizing algorithm and project action transport preserved.
- Removed only the obsolete Web ManagementPanel component and entry points; recoverable from Git. Its shared host operations remain intact.
- GitNexus impact/detect-changes unavailable: no indexed repositories. Verified via contract/source/reference search and Git diff instead.
- Refreshed codebase-memory index; ready, new readProjectFiles caller confirmed in ProjectFilesPanel.
- Build retains the existing large-chunk advisory; no additional dependency introduced.
- Per project rules, no application/dev server launched. Desktop/browser/Safari visual interaction and bilingual manual switching NOT performed; dock/drawer transitions still require user acceptance.
- No installer repackaging or remote push in this task. Prior image-success-toast removal preserved.
