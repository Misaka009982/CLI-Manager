# History List and Search Index Contracts

## Scenario: Cached history list and full-text search

### 1. Scope / Trigger

- Trigger: changing history list loading, global search, history root discovery, or JSONL cache invalidation.
- Goal: list/search requests must not synchronously parse every Claude/Codex transcript.

### 2. Signatures

- Existing commands remain compatible: `history_list_sessions(...) -> Vec<HistorySessionSummary>` and `history_search(...) -> Vec<HistorySearchResult>`.
- Index commands: `history_get_index_status(...) -> HistoryIndexStatus` and `history_refresh_index(..., wait) -> HistoryIndexStatus`.
- Event: `history-index-status` with `rootsKey`, `phase`, `indexedFiles`, `totalFiles`, `generation`, `partial`, `lastCompletedAt`, and `error`.
- Derived cache: installed `.cli-manager/history-cache/history-catalog.db`; Tauri dev `.cli-manager/history-cache-dev/history-catalog.db`.

### 3. Contracts

- The catalog DB is derived and rebuildable; never store it in `cli-manager.db` or treat it as user-authored data.
- List requests query cached summaries first and schedule fingerprint-based background refresh.
- A realtime lookup scoped to `source=grok`, an exact UUID session ID, `limit=1`, and `offset=0` may bypass a catalog miss by checking only `<grok-root>/sessions/<workspace>/<session-id>/updates.jsonl`; it must validate the UUID before joining paths and still honor the optional project path.
- Realtime forced refresh uses `history_refresh_index(..., wait=false)`. A large derived catalog rebuild must never hold the panel's single-flight polling request; later polls consume the direct Grok result or refreshed catalog.
- Opening history must schedule the same TTL-governed refresh even when the frontend reuses its in-memory list.
- Search requires at least three Unicode characters and uses FTS5 trigram literal matching; user text must be quoted/escaped before `MATCH`.
- First indexing is recent-first and partial results remain usable. A ready generation change reloads the list and current search.
- Project filtering uses indexed normalized `cwd` plus Claude encoded project keys; it must not reopen every JSONL in the request path.
- Editing/deleting/converting history marks the catalog dirty. Refresh replaces only changed files and removes missing files.
- WSL history inventory continues to use `wsl.exe` discovery rather than native recursive UNC enumeration.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Query has fewer than 3 characters | Return no global hits; frontend shows the minimum-length hint. |
| Catalog is empty but legacy JSON cache exists | Seed summary rows, return the cached list, then build message FTS in background. |
| File fingerprint is unchanged | Reuse catalog rows without parsing the transcript. |
| File changed or parser version changed | Atomically replace that file's summary/message/FTS rows. |
| File disappeared | Delete its message and summary rows. |
| Catalog refresh fails | Keep previous rows and emit `phase=error`; never delete source JSONL. |
| Catalog DB is malformed | Recreate only the derived catalog and rebuild. |
| Exact Grok UUID is absent from catalog but exists on disk | Return that session directly without scanning every transcript or falling back to the project's latest session. |

### 5. Good/Base/Bad Cases

- Good: opening history with thousands of files returns cached rows before the background scan completes.
- Good: typing a three-character code fragment queries FTS without reading transcript files.
- Base: the first install has no legacy cache, so progress and partial results appear until indexing completes.
- Bad: calling `refresh_history_index()` or `iter_session_messages_filtered()` for every keystroke.
- Bad: storing the FTS cache in the main user database or clearing usable rows after a transient scan error.

### 6. Tests Required

- Rust: FTS schema/triggers support Chinese and ASCII trigram matches; literal quoting handles embedded quotes.
- Rust: unchanged fingerprints skip parsing; changed and deleted files update only their own rows.
- Rust: project/source filters and pagination preserve existing command behavior.
- Rust: exact Grok UUID lookup finds the matching workspace session, rejects a different project path, and rejects non-UUID traversal input.
- Frontend: stale searches cannot overwrite the newest query; one/two-character input does not invoke search.
- Run `cargo test history --lib`, `cargo check`, and `npx tsc --noEmit`.

### 7. Wrong vs Correct

#### Wrong

```rust
for entry in refresh_history_index(&roots) {
    iter_session_messages_filtered(&entry.file_ref.path, &query, collect_hit)?;
}
```

#### Correct

```rust
let hits = catalog::search_sessions(&roots, &query, source, project_path, limit).await?;
catalog::ensure_refresh(app, roots, false, false).await?;
```

## Scenario: Bound Terminal Markdown Preview Freshness

### 1. Scope / Trigger

- Trigger: a completed local Claude/Codex Hook turn asks the terminal Markdown preview for the exact bound `cliSessionId` before the history catalog has observed the newly written transcript.
- Goal: the preview may wait for one targeted catalog refresh without blocking PTY output, losing the terminal background-image rendering path, or showing another session.

### 2. Signatures

- Frontend helper: `fetchLatestProjectSessionDetail(projectPath, prev, source, cliSessionId, options?)`.
- Realtime options: `forceCatalogRefresh?: boolean`, `freshDetail?: boolean`, and `waitForCatalogRefresh?: boolean`.
- Tauri command: `history_refresh_index(..., wait: boolean) -> HistoryIndexStatus`.

### 3. Contracts

- A bound preview lookup must match `source + cliSessionId`; a project/path miss must never fall back to an unrelated recent session.
- `waitForCatalogRefresh=true` is reserved for the explicit bound Markdown preview and is passed to `history_refresh_index`; statistics polling keeps the default non-blocking `false` behavior.
- The preview records its load trigger only after receiving a non-null matching detail. A catalog miss, parse error, or transport error remains retryable when the panel is opened or refreshed.
- The preview consumes `SessionTranscriptContent` only; it must not alter xterm output, the terminal background-image wrapper, transparency, WebGL policy, or split geometry.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Exact session is already indexed | Load detail through the normal fast path. |
| Exact session is missing and preview requests freshness | Wait for one forced catalog refresh, then retry the exact lookup. |
| Refresh or detail loading fails | Show the existing preview error and leave the trigger uncommitted so a later open/refresh can retry. |
| Source/session identity mismatches | Return no detail; never display another session's answer. |
| Background image is active | Keep the existing terminal DOM/background stacking and xterm content path unchanged. |

### 5. Good/Base/Bad Cases

- Good: Hook completion races catalog indexing; the preview waits for the refresh and renders the final assistant message for the same session.
- Base: the catalog already contains the session; no forced refresh is needed.
- Bad: cache a failed hidden preload trigger and make opening the visible panel permanently reuse the failure.
- Bad: use the project's latest session as a fallback when the bound `cliSessionId` is absent.

### 6. Tests Required

- Frontend source regression test: assert preview freshness passes `waitForCatalogRefresh=true`, the store forwards it as `wait`, and failed loads do not write the loaded trigger.
- Frontend background regression test: assert the existing terminal background-enabled wrapper and xterm container remain present.
- Run `npx tsc --noEmit` and the Markdown preview/background layout Node tests.

### 7. Wrong vs Correct

#### Wrong

```typescript
loadedTriggerRef.current = trigger;
void loadLatest();
```

#### Correct

```typescript
void loadLatest(trigger);
// inside the successful matching-detail branch:
loadedTriggerRef.current = trigger;
```

## Scenario: Catalog Schema Compatibility Upgrade

### 1. Scope / Trigger

- Trigger: adding columns, indexes, triggers, or constraints to the rebuildable `history-catalog.db` schema.
- Goal: installed catalogs must upgrade in place without requiring users to delete cache files.

### 2. Signatures

- Schema entry point: `ensure_schema(conn: &mut SqliteConnection) -> Result<(), String>`.
- V2 schema upgrade: `ensure_v2_schema(conn: &mut SqliteConnection) -> Result<(), String>`.
- Compatibility helper: `ensure_column(conn, table, column, definition) -> Result<(), String>`.
- `PRAGMA user_version` is written only after all table, column, index, and metadata updates succeed.

### 3. Contracts

- Compatibility columns must be ensured before creating any index, trigger, constraint, or query that references them.
- Fresh database creation and legacy upgrade must converge on the same final schema and indexes.
- Compatible upgrades preserve catalog rows. Destructive recreation remains limited to malformed or non-database files.
- Schema initialization is idempotent; reopening an upgraded catalog must not rewrite or reject its schema.
- Catalog opens must serialize schema initialization inside the process so compatibility `PRAGMA table_info` and `ALTER TABLE` steps cannot race across connections.
- Foreign-key support indexes for cascades and `ON DELETE SET NULL` paths must be created and upgraded idempotently; deleting or replacing one history session must not scan unrelated `history_message_parts`, `history_tool_events`, or child session relation rows for every message.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Catalog file does not exist | Create the complete current schema. |
| Older table lacks a newly required column | Add the column with its compatibility default before dependent DDL runs. |
| Older index conflicts with the replacement index | Drop the obsolete index after columns exist, then create the replacement. |
| Older schema lacks FK support indexes | Create the missing indexes in place and advance `user_version`; preserve all catalog rows. |
| Catalog already has the current `user_version` | Return through the fast path without schema writes. |
| Compatible upgrade statement fails | Return the error and do not advance `user_version`. |
| Two connections first-open the same legacy catalog | Both opens succeed; only one compatibility upgrade runs at a time. |

### 5. Good/Base/Bad Cases

- Good: an existing active source row gains `scope_kind=configured` and `scope_key=desktop`, then participates in the scoped unique index.
- Base: a fresh catalog creates the new columns with the table and later creates the same index idempotently.
- Bad: place `CREATE INDEX ... scope_kind` in the initial statement list before `ensure_column(..., "scope_kind", ...)`.

### 6. Tests Required

- Build the previous-version source table and obsolete index in memory, set the old `user_version`, insert an active row, then call `ensure_schema`.
- Assert the existing row survives with compatibility defaults, the replacement index exists and enforces uniqueness, and a second `ensure_schema` call succeeds.
- Open one legacy catalog concurrently through two connections and assert both opens complete with the current schema version.
- Simulate a previous catalog schema missing FK support indexes, run `ensure_schema`, and assert the indexes exist without dropping rows.
- Force a metadata write failure and assert `user_version` remains at the previous version.
- Keep fresh-schema tests and the focused `cargo test history --lib` suite passing.

### 7. Wrong vs Correct

#### Wrong

```rust
create_scoped_index(conn).await?;
ensure_column(conn, "history_source_instances", "scope_kind", definition).await?;
```

#### Correct

```rust
ensure_column(conn, "history_source_instances", "scope_kind", definition).await?;
create_scoped_index(conn).await?;
```

## Scenario: Scoped SSH Remote History

### 1. Scope / Trigger

- Trigger: changing SSH Agent history discovery/parsing, remote bridge history RPCs, catalog sync, or remote list/search/detail routing.
- Goal: expose project-scoped remote Claude/Codex history without copying the remote history tree or treating POSIX paths as desktop-local paths.

### 2. Signatures

- `history_remote_sync(...) -> Result<Value, String>` returns the Agent sync payload plus `applied: boolean`.
- Agent `HistoryScopeRequest.forceRefresh: boolean` is camel-case on the wire and defaults to `false` when older callers omit it.
- `catalog::apply_remote_sync(host_id, result) -> Result<bool, String>` returns `false` only when persisted generation/cursor state is newer.
- `ssh_db_record_history_source(input: SshHistorySourceInput) -> Result<(), String>` is the only write path for remote-history integration identity in `cli-manager.db`.
- Frontend `requestRemoteHistorySync(context, options) -> Promise<SshRemoteHistorySyncResult>` owns keyed in-flight request reuse and integration metadata persistence.

### 3. Contracts

- Remote `sourceInstanceId` is stable for `(remoteMachineId, sshUser, source, canonicalConfigRootHash)` and does not include `hostId`, project ID, client ID, or replaceable Agent installation ID.
- The Agent owns one rebuildable index per `(source, configRootHash)`. Writers use an Agent-side cross-process lock whose directory, permissions, and owner record are acquired transactionally; readers reuse the published generation.
- A non-forced sync with a compatible, complete index that covers every requested project path returns the requested page before acquiring the writer lock. It must not walk history directories or rewrite `index.json`.
- Missing/incompatible/partial indexes, project-scope expansion, and `forceRefresh=true` enter incremental discovery. Discovery orders files by descending modification time; a refresh with no entry, scope, tombstone, or completeness-state change preserves the published generation and index file modification time.
- JSONL indexing is append-aware and handles truncate, same-size rewrite, rotation, partial tails, tombstones, and project-scope expansion. A record larger than the 8 MiB read window is skipped with bounded cursor progress until its newline.
- Agent cursors are `generation:offset`. A generation mismatch resets pagination to offset zero; desktop fetches 21 summaries to display 20 and requests the next Agent page only from load-more.
- Desktop callers with identical host/source/root/project/cursor/limit/force-refresh inputs share one in-flight sync request, including the local integration metadata write. `consumerId` is not part of the key; the shared RPC uses a dedicated ephemeral bridge consumer released only after the request settles, so closing the first window cannot terminate another caller's shared request. Different sources, cursor pages, and refresh modes remain independent.
- A non-empty Desktop cached page renders before one background forced refresh. A known source identity with no cached rows waits for a non-forced Agent page, allowing a compatible Agent index to serve the first page without a scan. Load-more is non-forced; manual refresh is forced.
- Catalog apply obtains SQLite's short writer lease inside the transaction, then compares the persisted source generation and cursor offset. Lower generations and lower offsets in the same generation are ignored and reported as not applied; they must not replace session rows, source state, cursor, or frontend context.
- Catalog input validation, numeric bounds, and JSON serialization complete before `BEGIN IMMEDIATE`. Main-database integration persistence uses WAL, a 15-second busy timeout, one connection, and one `BEGIN IMMEDIATE` transaction; the WebView must not write `ssh_agent_tool_integrations` directly.
- Remote catalog coordination must not reuse the full local refresh mutex or add a process-wide SSH synchronization mutex. WAL reads remain concurrent; SQLite serializes only the actual write transaction.
- The existing `history-catalog.db` stores remote summaries, usage facts, freshness, cursor, and identity. Summary materialization must remove persisted messages, tool events, file changes, and corresponding FTS rows.
- Full remote detail is online-only and lives in a bounded in-memory LRU. Offline behavior guarantees cached list/summary/usage only, with explicit stale/disconnected state.
- Protocol minor 3 advertises `historyDetailChunks`: payload chunks are at most 256 KiB inside the existing 1 MiB frame, aggregate detail is at most 64 MiB, and desktop validates request ID, order, total, size, and one end-to-end deadline.
- Remote history is read-only. Remote refs and paths never enter local/WSL file, Git, provider, edit, delete, snapshot, or resume APIs.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Cursor is not `generation:offset` or its generation differs from the result | `history_remote_cursor_invalid`; no catalog write |
| Incoming generation is lower than persisted generation | return `applied=false`; preserve catalog and frontend context |
| Incoming generation is equal and cursor offset is lower | return `applied=false`; preserve catalog and frontend context |
| Incoming generation is newer or same-generation offset advances | apply the complete summary transaction and return `applied=true` |
| Complete compatible index, covered scope, `forceRefresh=false` | return the cached page without writer lock, directory discovery, generation change, or index write |
| Partial index, expanded scope, or `forceRefresh=true` | run incremental discovery; tombstones only after complete discovery |
| Two callers use identical result-affecting request inputs | share one remote RPC and one integration metadata write even when `consumerId` differs |
| Catalog writer remains locked after its bounded wait | `history_catalog_busy`; preserve cached rows |
| Main integration metadata remains locked after its bounded wait | `ssh_agent_history_metadata_busy`; preserve the committed catalog result and existing integration row |

### 5. Good / Base / Bad Cases

- Good: a stats poll and history refresh request the same first page concurrently and share one Promise.
- Good: opening a project with cached summaries renders immediately, then a forced refresh finds no changes and leaves `index.json` untouched.
- Good: page offset 20 commits before an older offset 10 response; offset 10 is ignored without blocking readers or another source.
- Base: equal generation and equal cursor replay is idempotent and may reapply safely.
- Base: Desktop cache is absent but the Agent has a complete index; the awaited non-forced first page returns without scanning.
- Bad: guard all remote sources with `CATALOG_REFRESH_LOCK` or let an old response update `sync_cursor_json` after a new response.
- Bad: key shared requests by `consumerId`, use that window's bridge consumer for the shared RPC, or write integration metadata through pooled frontend SQL calls.

### 6. Tests Required

- Agent: append/partial/truncate/rewrite, project scope, tombstones, stable identity, lock cleanup/recovery, oversized-record progress, cursor reset, complete-index reuse, unchanged no-write, recent-first discovery, and full history suite.
- Desktop: strict remote identity/continuation validation, numeric overflow before transaction, summary-only cleanup, pagination, stale generation/cursor rejection, distinct busy error mapping, metadata idempotency/rollback, detail chunk validation/deadline, LRU eviction, bridge consumer lifetime, and catalog tests.
- Frontend: TypeScript check plus manual rapid project/filter/window switching to confirm shared refresh survives the first consumer closing and stale list/search/detail requests cannot replace the current SSH context.

### 7. Wrong vs Correct

#### Wrong

```rust
sync_cursor_json = excluded.sync_cursor_json;
generation = excluded.generation;
```

#### Correct

Obtain SQLite's writer lease, compare persisted generation/cursor inside that transaction, and return `applied=false` before any source/session mutation when the response is stale.

## Scenario: Additive History Conversion and Explicit Deletion While Target CLI Runs

### 1. Scope / Trigger

- Trigger: changing Claude/Codex history conversion, explicit history deletion, target bundle writers, shared JSONL indexes, or runtime mutation guards.
- Goal: additive conversion and user-confirmed deletion must not be blocked merely because another same-source CLI process exists; backup restoration remains exclusive.

### 2. Signatures

- Tauri command remains `history_convert_session(file_path, claude_config_dir, codex_config_dir, source, project_key, target_source) -> Result<HistoryConversionResult, String>`; the result includes both the target summary and the target detail parsed directly from the newly written file.
- Process guard remains `is_target_tool_running(source: &str) -> bool` for backup restore and restore-plan callers.
- Delete entry remains `history_delete_session(...)`; its internal `delete_session_tree_with_backup_root(...)` does not use the source-wide process guard.
- Shared JSONL helper remains `append_jsonl_line(path: &Path, line: &Value) -> Result<(), String>`.

### 3. Contracts

- Conversion is additive: every attempt creates a new target-native UUID and an exclusive rollout/transcript path; it never edits or replaces an active session.
- Conversion success is self-contained: before returning, the backend parses the new target transcript and verifies that detail source, session id, and file path match the returned summary. The frontend must not depend on an immediate catalog refresh to display the result.
- For a Claude target, the returned summary/detail `project_key` comes from the canonicalized target file's parent directory after the write. Do not return the lowercased cwd-derived key: on case-insensitive Windows filesystems an existing mixed-case Claude project directory may be reused, and later inventory reports that on-disk name.
- A running target CLI alone must not return `history_target_tool_running` from `history_convert_session`.
- Codex `history.jsonl` and `session_index.jsonl` records are serialized with their trailing newline and written through one append `write_all` call.
- Codex `state_5.sqlite` registration uses SQLite locking and the bounded 15-second busy timeout. A real busy timeout, schema error, or I/O error is returned; it is never converted to success.
- Explicit delete does not call `is_target_tool_running`: the process scan identifies only a CLI source, not the selected session, so it cannot prove that the selected file is active. Delete still creates backups, rolls back failures, and respects the source manual-recovery lock.
- Backup restore and restore-plan paths continue to call `is_target_tool_running`; they may overwrite an existing artifact and remain exclusive.
- `history_source_manual_recovery_required` still blocks conversion when the target source has an unresolved recovery lock.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Target CLI is running and conversion writes a new session | Continue conversion; do not return `history_target_tool_running` |
| Target SQLite writer remains busy past 15 seconds | Return `codex_state_register_failed` or the underlying database-open error |
| Target source has a manual recovery lock | Return `history_source_manual_recovery_required`; write nothing |
| New target transcript cannot be parsed back with matching identity | Return `history_conversion_detail_mismatch`; do not report conversion success |
| Claude target file cannot be canonicalized or has no project parent | Return `history_conversion_target_file_unavailable` or `history_conversion_target_project_unavailable`; do not report conversion success |
| Windows reuses an existing Claude project directory whose case differs from the cwd-derived key | Return the directory's actual on-disk name in summary/detail so `validate_session_file_ref` can reopen it |
| User confirms deletion while any same-source CLI is running | Continue the validated backup-and-delete transaction; do not return `history_target_tool_running` |
| Backup restore or restore-plan runs while the source CLI is active | Return `history_target_tool_running` |
| Source or target is unsupported, identical, or a subagent root | Preserve the existing stable validation error; write nothing |

### 5. Good / Base / Bad Cases

- Good: Claude converts to a fresh Codex rollout while other Codex sessions remain active; both shared index lines parse and the SQLite thread row registers.
- Good: Codex converts to Claude under an existing `F--ws-Labway-Fee-Control` directory; the result returns that exact project key and ordinary detail reopening succeeds.
- Good: the user deletes selected old Codex sessions while an unrelated Codex terminal is open; every selected file still goes through backup and rollback handling.
- Base: no target CLI is running; conversion behavior and result payload are unchanged.
- Bad: return the lowercased cwd encoding after Windows has reused a mixed-case directory; inventory then rejects the same file with `session_file_not_indexed`.
- Bad: apply the source-wide process guard to explicit deletion; one unrelated Codex process blocks deleting every Codex history file.
- Bad: remove the guard from backup restore and overwrite an artifact while the source CLI is active.
- Bad: keep the process guard at the conversion entry and reject every conversion from a machine currently using Codex.

### 6. Tests Required

- Rust: Claude -> Codex and Codex -> Claude writer/parser round trips preserve the new session id and messages; returned summary and detail identities match.
- Rust: Codex -> Claude with an existing mixed-case Windows project directory returns the inventory project key, passes `validate_session_file_ref`, and rebuilds detail through the ordinary reopen path.
- Rust: concurrent `append_jsonl_line` calls produce the expected record count and every line parses as JSON.
- Rust/source audit: conversion and explicit delete have no target-process guard; backup restore and restore-plan retain it.
- Frontend/static regression: deleting sessions while a same-source process exists is not rejected at the backend delete boundary.
- Run `cargo fmt -- --check`, focused conversion/append tests, `cargo test history --lib`, and `cargo check`.

### 7. Wrong vs Correct

#### Wrong

```rust
if is_target_tool_running(&target_source) {
    return Err("history_target_tool_running".to_string());
}
convert_history_session(&detail, &target_source, &roots)?;
```

#### Correct

```rust
// Conversion owns a fresh target id/path; explicit deletion owns a backup transaction.
let result = convert_history_session(&detail, &target_source, &roots)?;
let deleted = delete_session_tree_with_backup_root(&file_ref, &backups_dir)?;

// Backup restore still refuses to overwrite while the source CLI is active.
let plan = build_file_restore_plan(&file_ref.path, &backups_dir, Some(&file_ref.source));
```
