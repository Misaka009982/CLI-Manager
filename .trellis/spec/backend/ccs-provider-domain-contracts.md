# CCS-Compatible Provider Domain Contracts

> Planned implementation contract for the provider-domain rebuild. Read together
> with task `08-02-key` before modifying supplier, project-switch, Home, Hook,
> history, or terminal-launch code.

## Ownership and compatibility

- The app-owned provider domain lives in
  `<cli-manager data root>/providers.db`; it is not embedded in
  `cli-manager.db`.
- Copy CCS supplier-domain schema/migrations/settings configuration shapes from
  an explicitly pinned upstream commit. Preserve provider composite identity
  `(id, app_type)`; do not treat ID alone as globally unique.
- Public types are `claude`, `codex`, and `grok`; storage/import maps
  Grok Build to `grokbuild`.
- `.cc-switch/cc-switch.db` is a read-only import source only. No normal
  catalog, global apply, project resolver, terminal launch, badge, CC Connect,
  Hook, history, or restore path may read it after cutover.
- Keep historical provider migrations in `cli-manager.db` registered exactly
  as shipped. They are compatibility tombstones, not a schema to extend.

## Core data invariants

- Providers contain CCS-compatible `settings_config`, provider metadata,
  `meta.commonConfigEnabled`, ordering and at-most-one current record per
  app type.
- Type common config belongs in the `settings` key
  `common_config_<app_type>`; it is never attached to one provider.
- `provider_api_keys` has a composite foreign key to providers and a partial
  unique index enforcing at most one active key per provider/type.
- A ready/current/scope-selectable provider has exactly one enabled active key.
  A draft may have zero. Activating/deleting/disabling a key and projecting it
  into `settings_config` are one SQLite transaction.
- Product policy is plaintext `api_key` storage in SQLite. It does not
  authorize accidental dissemination: default list DTOs, logs, diagnostics,
  errors, sync/export and journal payloads are masked.
- Multi-key is manual only. Do not add automatic validation, health, rotation,
  quota, cooldown, rate-limit, round-robin, failover, KeyRing, or proxy code.

## Configuration and writer contract

- Claude editor/writer owns full `settings.json`; Codex owns full
  `auth.json` and `config.toml`; Grok Build owns full `config.toml`.
  Every type exposes base URL, active key and selected model as typed fields
  plus raw documents.
- Effective order is live non-owned fields + type common config + provider
  settings + active-key projection. Providers win scalar/table conflicts,
  arrays replace, JSON `null` is explicit override.
- Parse and merge in Rust. Use structured TOML editing where live user
  documents must retain comments/order. Frontend parsing is only an editor aid.
- Writers change only documented provider-owned paths. Preserve Hooks,
  permissions, MCP, project trust, statusline and unknown user fields.
- Global apply resolves a selected Home, stages/parses all target files,
  creates recoverable backups, replaces/verifies every target, then commits
  current state. Journal and compensate partial failure; recover unfinished
  operations on next startup. Codex must compensate both files.

## Scope and Home contract

- Scope resolution is Worktree v2 reference > project v2 reference > native
  global current. A reference includes app type, source `cli-manager`,
  schema version and provider ID.
- Resolve and materialize providers only from `providers.db`. No name/UUID
  heuristic maps a legacy CCS reference; import refs perform the mapping or a
  repair issue is retained.
- Project materialization is not global switch: Claude generated settings +
  `--settings`; Codex generated profile/config; Grok per-process
  `GROK_HOME`. Secrets are child-process environment/config data, never shell
  command text. Remote SSH does not receive local key material.
- `CliHomeResolver` is the only default source for global targets, Hook/
  statusline targets and automatic history roots. Explicit feature roots have
  higher priority and must be labelled rather than overwritten.
- Home preferences are per local/WSL environment identity. Validate root
  directories; do not accept a CLI subdirectory as Home.

## IPC boundary

Group new Tauri commands under catalog, key, common, global, scope, Home,
environment and import prefixes. Rust validates all IDs, types, document
syntax, reference state, filesystem target, lock and secret projection.

Read DTOs are deliberately shaped:

- List/detail DTO: no full secret.
- Explicit credential/auth reveal: purpose-bound and not persisted by frontend
  state/logging.
- Effective/live preview: reveal credential only after explicit action and
  never reuse its payload in toasts, journal, diagnostics, or export.
- Environment result: variable name/scope/presence/masked fingerprint only.

Use stable error codes; never stringify an SQL error, raw config body, Home
contents, or secret into a user-visible command error.

## Scenario: Native provider catalog, Home apply, and scope resolution

### 1. Scope / Trigger

- Trigger: any new/changed Claude, Codex, or Grok provider; key; common
  configuration; global Home apply; project/Worktree reference; Home choice;
  or CCS import.
- Goal: replace CCS runtime coupling with a complete app-owned compatible
  provider domain without changing an active terminal session.

### 2. Signatures

```text
provider_catalog_list(appType) -> ProviderCard[]
provider_catalog_get(providerId, appType) -> ProviderEditor
provider_catalog_save(input) -> ProviderEditor
provider_key_set_active(providerId, appType, keyId) -> ProviderEditor
provider_common_get(appType) -> CommonConfig
provider_common_save(appType, document) -> CommonConfig
provider_global_preview(providerId, appType, homeIdentity) -> ApplyPreview
provider_global_apply(providerId, appType, homeIdentity, previewFingerprint) -> ApplyResult
provider_scope_resolve(projectId, worktreeId?, appType) -> ResolvedProvider
provider_home_select(environment, mode, homePath?) -> DerivedCliTargets
provider_environment_inspect(homeIdentity) -> EnvironmentReport
provider_import_preview(source) -> ImportPreview
provider_import_commit(previewId, options) -> ImportResult
```

- All provider/key calls include `appType`; the command must reject an ID/key
  owned by another type.
- `previewFingerprint` is required for apply so an external live-file edit
  cannot be overwritten from a stale preview.

### 3. Contracts

- `ProviderEditor` carries full editable documents and structured endpoint/
  model fields; list DTOs are secret-masked.
- `ApplyPreview` contains target paths, non-secret field diffs and live
  fingerprints. `ApplyResult` records verified target hashes and current
  state only after every writer succeeds.
- A key reveal/auth-editor command is explicit, non-cacheable and omitted from
  store persistence/logging; normal editor/list/diagnostic DTOs never include
  full key content.
- `DerivedCliTargets` is produced only by `CliHomeResolver`; it includes
  local/WSL identity and derived Claude/Codex/Grok config/history/Hook roots.

### 4. Validation & Error Matrix

| Condition | Error code / result |
| --- | --- |
| Unsupported or mismatched app type | `provider_app_type_invalid` / `provider_identity_mismatch` |
| Missing provider/current active key | `provider_not_ready` / `provider_key_not_active` |
| Invalid raw JSON/TOML or conflicting key projection | `provider_config_invalid` / `provider_key_projection_conflict` |
| More than one active key | database unique-index failure mapped to `provider_key_active_conflict` |
| Referenced provider disable/delete | `provider_referenced` with scope summary |
| Bad/readonly/unreachable Home | `provider_home_invalid` / `provider_home_not_writable` |
| Live file changed after preview | `provider_apply_conflict` |
| Stage/replace/verify/restore failure | `provider_apply_failed` / `provider_recovery_required` |
| CCS source missing/corrupt/unsupported | `provider_import_source_invalid` |
| Unmapped legacy scope reference | persisted repair issue; no fallback resolution |

### 5. Good / Base / Bad Cases

- Good: activate Key B for current Codex provider, preview the changed
  `auth.json`/`config.toml`, explicitly apply, then a newly launched Codex
  process uses Key B while an old terminal is unchanged.
- Base: a draft provider with no key remains editable but cannot be global or
  scope selected.
- Bad: the project launch looks up a CCS provider by the same display name.
- Bad: common config is stored in the selected provider record or a Codex
  writer replaces the entire file and removes Hooks/MCP.

### 6. Tests Required

- Database: core CCS tables, composite identity, type common settings, active
  key unique index, key projection transaction, import reference idempotence.
- Writer: all type documents, unknown field preservation, external-change
  fingerprint conflict, Codex second-file failure compensation, crash journal
  recovery.
- Resolver: auto/manual local/WSL Home; explicit Hook/history overrides;
  Worktree > project > global; no CCS file in normal resolution.
- Import: mainline single key, PR multi-key, OAuth/empty/corrupt source,
  duplicated names, changed fingerprints and unmapped legacy reference.

### 7. Wrong vs Correct

#### Wrong

```text
set providers.is_current = 1
write ~/.codex/auth.json
write ~/.codex/config.toml
```

The database can say “current” while the second file fails.

#### Correct

```text
preview + lock + stage + parse + backup + replace all targets + verify
  -> commit current state and journal
  -> otherwise compensate files and retain recovery journal
```

## Required implementation verification

- Fresh and historical app databases start correctly.
- Core schema/composite FK/current/active-key constraints are enforced by DB.
- Claude/Codex/Grok raw documents and typed endpoint/model controls round-trip.
- Common config is type-scoped and merges with correct precedence.
- Global apply preserves non-owned fields and compensates partial writes.
- Local/WSL Home alignment covers global files, Hook and history defaults.
- Worktree/project/global precedence and launch snapshots work with CCS absent.
- Single/multi-key CCS import is previewable, idempotent and has no heuristic
  reference fallback.
