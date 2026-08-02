# Phase 0 Discovery List

## Scenario enumeration

- [x] CCS absent, empty, damaged, or configured to a moved path: native CRUD must remain independent.
- [x] Claude Code, Codex, Grok: same catalog/key state rules, type-specific config parser.
- [x] Provider with 0/1/N keys; first-key activation; manual activation; active-key replacement deletion.
- [x] Duplicate provider names, malformed config, secret embedded in config, empty/oversized inputs.
- [x] Concurrent activation and database busy/failure: transaction and partial unique index are authoritative.
- [x] Draft/ready/disabled; referenced disable/delete; global/project/Worktree reference sources.
- [x] Focused/unfocused/minimized/tray, no/single/multi/split/Workspan terminals: CRUD is durable database state and does not mutate PTYs in this phase.
- [x] PowerShell/CMD/Pwsh/Git Bash/WSL: Phase 1 catalog is shell-neutral; config materialization and Home targets remain Phase 2+.
- [x] Main repo/Worktree/missing path: native references are inspected, but no scope launch behavior changes in this phase.
- [x] Hook installed/missing/partial/third-party: no Hook file mutation in this phase.

## Code touchpoints

- [x] `src-tauri/src/lib.rs::migrations` — add native schema migration. GitNexus risk LOW; direct consumer is app startup `run`.
- [x] `src-tauri/src/lib.rs::run` — register new Tauri commands. GitNexus risk LOW; application entry only.
- [x] `src-tauri/src/commands/mod.rs` — expose provider command module.
- [x] `src-tauri/src/provider/*` — new model/repository/service/config-engine ownership boundary.
- [x] `src-tauri/src/commands/provider.rs` — thin IPC boundary; stable camelCase DTOs, no secret reads.
- [x] `src/components/settings/pages/ProviderSettingsPage.tsx::ProviderSettingsPage` — replace CCS read-only catalog with native CRUD. GitNexus risk LOW; direct consumer is `SettingsModal`.
- [x] `src/stores/providerStore.ts` and `src/lib/providerTypes.ts` — new authoritative redacted frontend state and types.
- [x] `src/lib/i18n.ts` — add all native provider UI/error/ARIA strings in Simplified Chinese and English.
- [x] `src/components/SettingsModal.tsx` — confirmed unrelated: current page prop/signature can remain stable.
- [x] `src/stores/settingsStore.ts::ccSwitchDbPath` — confirmed unrelated for native CRUD; retained for later import source.
- [x] `src/components/ProviderSwitchModal.tsx`, `terminalStore`, `projectStore`, `cc_connect` — confirmed deferred to Phase 3; no runtime selection changes in this Goal.
- [x] Hook/Statusline/history roots — confirmed deferred to Phase 4; no directory mutation in this Goal.
- [x] WebDAV/sync payload — confirmed later Phase 6; Phase 1 exposes no provider sync payload and never adds `secret_text` to ordinary sync.

## Cross-layer boundaries

```text
React form (plaintext only in local input)
  -> providerStore write action
  -> Tauri camelCase request
  -> Rust validation + SQL transaction
  -> SQLite secret_text
  -> redacted Rust DTO
  -> Zustand snapshot / UI
```

Rust is authoritative for validation, identity, transactions, state transitions, secret masking, and config parsing. The frontend owns interaction drafts, localized presentation, and confirmation only.
