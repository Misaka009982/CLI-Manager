# Web project files

Approved: replace Web management modal with read-only file sidebar; no desktop changes.

## Discovery and scenarios
- Workbench: replace entries, retain launch/history/project menus. WebTerminal reports layout only.
- New file panel captures device/project/Worktree; lazy directories, filename search, text/image preview.
- Existing transport and desktop file commands retained: uploads, permissions, root validation unaffected.
- Desktop UI/Rust/SSH/Git/Hook implementations outside modification scope.
- GitNexus impact unavailable (no indexed repositories); fallback: web-service contracts, rg and source.
- Dock only outside active canvas with enough desktop space. Never resize terminal to fit sidebar.
- Mobile/narrow viewport/subagent split: existing accessible drawer; keyboard does not change terminal policy.
- Tab/device/project/Worktree switch: abort old reads, reset results. Refresh is explicit, no filesystem watch.
- Offline/missing context/unsupported SSH/large or binary files: visible errors, no writes or automatic resubmission.
- Focus/tray/minimized/Hook/runtime differences use unchanged host implementation and authorization.
- Test bounded polling/cancellation/context isolation, geometry boundaries, Web build, terminal regressions, architecture.
- Browser/Safari verification remains manual per project rule. TEMP records; no remote push authorized.

## Follow-up: model-menu horizontal jump and desktop project collapse

- Root cause: every accepted terminal input, including Enter/arrows/menu controls, armed 1.5 seconds of cursor following; intermediate/hidden repaint cursor positions could scroll the Web viewport horizontally.
- Fix at input and parsed-output boundaries: only printable editing/backspace/single-line paste arm following; control/navigation input cancels it; hidden caret and intermediate cursor-move events cannot drive scrolling.
- Desktop Web project sidebar gains a persistent collapse toggle in the header. Keep the mounted project tree state; mobile continues using its existing drawer. No width transition that repeatedly resizes the terminal.
- Scenarios: model picker open/selection/confirmation, normal Unicode typing/paste/backspace, mouse reports, manual scroll, visible/hidden caret, reset/replay, tab switch, collapsed/expanded sidebar, details panel, narrow desktop/mobile widths, browser storage unavailable.
- Touchpoints: WebTerminal and terminalCursorView; Workbench/ProjectSidebar; Web CSS and bilingual strings. Desktop source, shared PTY ownership, server, file API and file tree reads remain outside changes.
- GitNexus impact unavailable (no registered index); memory reference search and actual source confirm the Web-only callers. Reuse current branch/task and TEMP release notes.
