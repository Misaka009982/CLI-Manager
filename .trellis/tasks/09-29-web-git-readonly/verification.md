# Verification — 1.4.1

## Baseline / scope

- Branch `feat/web-git-readonly` from latest fetched master `99ea43c0`; initial worktree clean. No remote push.
- Root cause: directory session mixed first-load and stale-cache revalidation loading state; new Git feature lacked Web registration/transport/UI entry.
- Touched: Web directory cache/session/file panel, shared read operation path, desktop/mobile inspector mounting, Git read UI/DTO/i18n/CSS; desktop management read routing and server allowlist. Native Git/PTY/desktop panels/DB/SSH untouched.
- GitNexus unavailable: used contracts + refreshed codebase-memory + source/diff. Call graph flags bridge direct callers high/critical; user informed. New query validation is isolated; write confirmation preserved.

## Checks

- Web and desktop TypeScript checks passed.
- Node directory/read-only Git/Diff regressions: 39 passed (`webProjectFiles`, `webGitRead`, `gitDiffLargePerformance`).
- Server Cargo test: 55 unit + 5 integration passed (including existing reconnect/authorization and new read kinds).
- Strict architecture: zero >2000-line files / zero violations.
- First test pass found old static `ProjectFilesPanel` mount assertion after introducing inspector; updated assertion to verify both real mount points and File child. Initial Web typecheck found untyped factory lambda; annotated explicitly and reran successfully.
- No application or long-running service launched for UI verification. Server tests use temporary test fixtures, not the user's service/database.

## Manual acceptance (not yet performed)

1. Install, start existing Web service, browser hard refresh; inspect desktop and Safari mobile Files/Git switch and drawer back/close. Verify terminal stays mounted and sidebar width still adjusts.
2. Main project/Worktree/nested repo switch during a slow query: no old repository data; empty/missing/offline/SSH states have readable feedback.
3. Changes groups, textual Diff and rename historical Diff; binary/oversize reports explicitly; no write controls. History search, previous/next 50-item pages and refresh.
4. Directory expand/reopen within 30s and after 30s but before 10min: cached contents show immediately without spinner; uncached slow directory retains loading feedback. Hover/focus prefetch doesn't scan recursively. Refresh/reconnect/logout invalidate correctly.
5. Chinese/English labels and 24-hour dates, keyboard navigation, narrow viewport/long filenames; runtime visual acceptance remains human verification.

## Release

- User approved commit before NSIS packaging, version 1.4.1. Implementation commit: `8505c78b`.
- `npm run tauri:build:local -- --bundles nsis --ci`: succeeded; desktop build 2m32s, Web build 10.63s, Rust release 2m23s, then NSIS compression. Only normal chunk-size/macOS-identifier/linker-output warnings; no MSI generated.
- Package: `src-tauri/target/local/release/bundle/nsis/CLI-Manager_1.4.1_x64-setup.exe`, 29,945,486 bytes, 2026-09-29 10:11:50 +08.
- SHA256: `8207647C8D42F1668A674E2950B4B65CF44BE662143C5AB82F845ACB255B059C`.
- NSIS script verified new `index-BIclJj0D.js`, `index-BorKK3Tw.css`, main executable and Web daemon resource paths; `apps/web/dist/index.html` references those same assets.
- Prior installer retained as `CLI-Manager_1.4.1_x64-setup-before-web-git-20260929.exe`, SHA256 `D07B6148055312F03B3286CD23E1FEAFFE9B9658F5245855DF324F7E4283CFB8`.
- Post-implementation index refresh confirmed real call edges for ProjectInspector and executeWebGitRead. Memory staged change detection returned an empty set despite staged changes; treated as unreliable and used explicit Git staged diff (23 paths) plus tests/source review as authority.
- Initial release rendered raw snapshot text; this presentation was rejected by the user and is superseded by the desktop-style correction below. No promise of zero latency on uncached first reads.
- Existing installer retained as rollback; no schema migration. If running the old host/Web service, restart after installing to load new operation handlers.

## Desktop-style presentation correction

- Existing branch/task/version retained. Root cause and touchpoint inventory in design.md. Wide branch/log/detail history workspace, shared graph metadata/layout, independent split/unified snapshot Diff with line numbers and semantic color; responsive mobile list/detail navigation and collapsible branch list.
- Reused desktop parser/Worker, limits and react-diff-view row primitives. Parser diagnostics injected from existing desktop controller, preserving its debug behavior. No desktop UI/PTY/Git writes changed. Existing branch query and validated history reference use the canonical readonly path, including nested repositories.
- Web and desktop TypeScript passed; strict architecture passed with zero violations. Initial 47-test batch: one test's translation-key regex accidentally matched `split("/")`; tightened to word-boundary `t(...)`, all 47 passed on rerun.
- Web production build passed (13.51s) and emitted the shared parser Worker. Only the existing chunk-size warning. No application or service launched for UI inspection.
- Additional actual split/unified row-rendering checks passed: line numbers, insert/delete classes, HTML escaping, and snapshot dependency boundary. Total targeted checks: 50 passed. Final strict architecture: 1189 files, zero violations.
- Refreshed codebase-memory index and confirmed GitHistoryWorkspace/GitSnapshotDiff callers. Change detection lists tracked paths but omits untracked files/symbol impact; explicit Git diff/status and source/test review cover all added entry points before staging.
- Additional manual acceptance: desktop history branch filter/table/selection/details; click working/history file for separate split Diff; light/dark and zh-CN/en-US; mobile unified default, switch split, branch expand, list/detail return; nested Esc/Tab closes only top dialog and restores focus; long lines/rename/binary/large patches; rapid repository/search changes and offline recovery. Visual acceptance is not claimed as automated.

### Corrected NSIS delivery

- Code commit `75afba30`; `npm run tauri:build:local -- --bundles nsis --ci` completed successfully. Desktop frontend 2m31s, Web16.30s, Rust release2m33s, then NSIS. No MSI or remote push.
- Package: `src-tauri/target/local/release/bundle/nsis/CLI-Manager_1.4.1_x64-setup.exe`; 29,988,080 bytes; 2026-09-29 11:30:35 +08.
- SHA256: `ED84A90258E866981E263060D3EE2A12011A21273925C500B9C0597787EE4892`.
- Verified NSIS script includes `index-CmHmTOmk.js`, `index-7O9kQf_9.css`, `gitDiffParser.worker-D5x4xMSv.js` and desktop/Web daemon resources; Web index references the same assets.
- Previous package retained as `CLI-Manager_1.4.1_x64-setup-before-git-layout-20260929.exe`, SHA256 `8207647C8D42F1668A674E2950B4B65CF44BE662143C5AB82F845ACB255B059C`.
- Install after fully exiting the old host, restart Web service, then reload browser. No data migration. Runtime UI verification remains manual per project policy.
