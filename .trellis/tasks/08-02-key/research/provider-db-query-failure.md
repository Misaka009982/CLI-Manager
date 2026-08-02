# Provider database query failure investigation

## Triage verdict

This is a root-cause fix. The symptom is a backend IPC/database failure, crosses the Tauri-to-SQLite boundary, and is produced by migration history rather than by the provider page renderer.

## Root-cause statement

The application database already records migration version 25 for an older `providers/provider_keys` schema, while the native provider implementation reused version 25 for `managed_providers`; SQLx therefore treats the native schema migration as already applied and the repository queries missing tables.

## Evidence

- The live database is the stable path resolved by `app_paths::db_path()`: `%USERPROFILE%\\.cli-manager\\cli-manager.db`.
- Read-only schema inspection found legacy `providers` and `provider_keys` tables, but no `managed_providers` or `managed_provider_keys` tables.
- `_sqlx_migrations` contains version 25 with description `create_providers_and_keys_tables` and `success = 1`.
- `provider_list` opens the stable database and immediately queries `managed_providers`; its SQL error mapping reduces the missing-table error to `provider_database_query_failed`.
- `tauri-plugin-sql` uses SQLx migration checksums. Replacing an already-applied migration's SQL is not a safe upgrade path; the old migration must remain in the resolved migration list and the native schema must use a new version.

## Discovery list

- [x] `src-tauri/src/provider/repository.rs`: `open_database` and `list_provider_summaries` are the failing database boundary; GitNexus upstream impact for `open_database` reported LOW risk and no indexed callers (Rust graph coverage is incomplete for this symbol).
- [x] `src-tauri/src/provider/service.rs`: provider list/detail commands route through the repository and must continue to use the stable database.
- [x] `src-tauri/src/provider/migration.rs`: native schema SQL and migration version need compatibility-preserving versioning.
- [x] `src-tauri/src/lib.rs`: `migrations()` is the SQLx/Tauri migration registry; GitNexus upstream impact reported LOW risk, one direct caller (`run`) and one startup flow.
- [x] `src-tauri/src/provider/mod.rs`: migration constants are re-exported to the registry.
- [x] `src/stores/providerStore.ts`: page-load errors are consumers only; no frontend fallback should mask a missing schema.
- [x] `src/components/settings/pages/NativeProviderSettingsPage.tsx`: renderer only displays the stable error and is unrelated to schema creation.
- [x] `src-tauri/src/app_paths.rs`: database path is shared by migration registration and native repository access; path divergence is ruled out.

## Scenario matrix for the fix

| Database state | Expected result |
|---|---|
| Clean database | Legacy v25 compatibility migration and native v26 migration both apply; provider page lists an empty catalog. |
| Existing database with old v25 provider tables | v25 checksum remains valid; v26 creates the native tables without deleting or rewriting legacy data. |
| Existing database with native v25 tables from an unreleased local Phase 1 build | This build's v25 migration was not part of the shipped compatibility baseline; keep the database backup and use the migration repair path before upgrading. |
| Database migration is still pending when the page opens | The migration completes before SQLx database load returns; repository queries then see the native schema. |
| Database is read-only or locked | The app reports a migration/database error; it must not silently claim that the provider catalog is empty. |

## Planned verification

- Add a migration-list regression test that asserts the legacy v25 entry is present before native v26.
- Add an idempotence test for the native schema SQL and retain existing repository CRUD tests.
- Run Rust format/check/tests and frontend type-check; inspect the resulting GitNexus change scope before committing.
