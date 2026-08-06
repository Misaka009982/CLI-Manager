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

## Phase 0 verified persistence boundary

### 1. Scope / Trigger

The provider domain must have a durable storage boundary before any catalog or
launch command is migrated away from CCS. This boundary is initialized during
desktop startup, after legacy app-file migration, while the existing
`cli-manager.db` provider migrations remain untouched.

### 2. Signatures

```text
app_paths::providers_db_path() -> Result<PathBuf, String>
app_paths::providers_db_url() -> Result<String, String>
provider::initialize() -> Result<(), String>
```

The initializer is an internal startup operation; it does not expose a
provider command or permit the frontend to open SQLite directly.

### 3. Contracts

- The database path is `<home>/.cli-manager/providers.db`.
- The connection uses WAL, `foreign_keys = ON`, `synchronous = NORMAL`, and a
  bounded 5-second busy timeout.
- Schema version 1 creates the CCS-shaped `providers` and `settings` tables,
  the composite `(provider_id, app_type)` manual-key table, and the
  Home/import/repair/apply-journal tables. `settings` is seeded with empty
  `common_config_claude`, `common_config_codex`, and
  `common_config_grokbuild` documents.
- Before applying a schema to an existing version-0 database, the WAL is
  checkpointed and the database is copied to
  `.cli-manager/backups/providers/providers.db.backup-<unix-ms>-<pid>.db`.
- Provider-domain initialization failure is logged as a warning and does not
  stop `cli-manager.db`, PTY, history, or the rest of desktop startup.
- No production provider command reads `providers.db` in Phase 0; later phases
  must add the domain repository/commands before removing CCS runtime reads.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Existing provider DB version is newer than the binary | `provider_db_version_unsupported`; preserve the file and continue app startup |
| Existing DB needs schema initialization | checkpoint, backup, apply schema, record checksum, then set version |
| Backup or schema initialization fails | `provider_db_backup_failed` / `provider_db_schema_failed`; preserve the main app startup |
| Required domain table is absent after initialization | `provider_db_table_missing`; do not expose the incomplete store |
| Two current providers share one app type | partial unique-index violation; later command layer maps it to a stable provider error |
| Two active keys share one provider/type | partial unique-index violation; later command layer maps it to `provider_key_active_conflict` |

### 5. Good / Base / Bad Cases

- Good: a fresh data root creates `providers.db`, seeds the three common
  documents, and leaves the historical `cli-manager.db` migration checksum
  unchanged.
- Base: an existing version-0 provider DB is backed up before schema creation;
  reopening a version-1 DB is idempotent and creates no second backup.
- Bad: putting the CCS-compatible tables into `cli-manager.db` or making
  startup fail because an optional provider DB cannot be opened.

### 6. Tests Required

- Assert WAL, foreign keys, schema version/checksum, required table presence,
  and the three common-config seed rows on a fresh database.
- Assert the same provider ID can exist for Claude and Codex, while a
  duplicate composite identity fails.
- Assert the composite key foreign key, cascade deletion, current-provider
  uniqueness, and active-key uniqueness.
- Assert a version-0 database is checkpointed/backed up and preserves its
  pre-existing marker; assert version-1 reopen is idempotent.
- Keep the historical v25/v26 migration checksum/registration tests passing.

### 7. Wrong vs Correct

#### Wrong

```text
open cli-manager.db -> add/alter the old provider tables -> mark provider current
```

This couples project/session startup to the removed prototype schema and can
invalidate existing SQLx migration checksums.

#### Correct

```text
legacy cli-manager.db migration unchanged
  -> open .cli-manager/providers.db with WAL/foreign keys/busy timeout
  -> checkpoint + backup before first schema write
  -> create independent provider-domain schema
  -> warn and continue if this optional store cannot initialize
```

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
- When a writer owns a credential-bearing document, it must remove stale
  provider credentials from every owned profile/entry before projecting the
  selected active key; an unselected Grok model profile or legacy top-level
  Codex auth field must not retain an imported credential.
- Global apply resolves a selected Home, stages/parses all target files,
  creates recoverable backups, replaces/verifies every target, then commits
  current state. Journal and compensate partial failure; recover unfinished
  operations on next startup. Codex must compensate both files.
- Scope launch snapshots are all-or-nothing: if materializing or writing any
  generated file, key projection, or manifest fails, remove the incomplete
  snapshot root before returning the error so no orphaned configuration or
  credential remains for later launch/recovery.

## Scope and Home contract

- Scope resolution is Worktree v2 reference > project v2 reference > native
  global current. A reference includes app type, source `cli-manager`,
  schema version and provider ID.
- Resolve and materialize providers only from `providers.db`. No name/UUID
  heuristic maps a legacy CCS reference; import refs perform the mapping or a
  repair issue is retained.
- Project materialization is not global switch: Claude generated settings +
  `--settings`; Codex process config overrides; Grok keeps the resolved real
  Home and applies the selected provider per process through `--model`,
  `GROK_MODELS_BASE_URL`, and `XAI_API_KEY`. Provider launches must never
  replace `GROK_HOME`, because Hook, MCP, history, skills, and user state share
  that Home. Secrets are child-process environment/config data, never shell
  command text. Remote SSH does not receive local key material.
- `CliHomeResolver` is the only default source for global targets, Hook/
  statusline targets and automatic history roots. Explicit feature roots have
  higher priority and must be labelled rather than overwritten.
- Home preferences are per local/WSL environment identity. Validate root
  directories; do not accept a CLI subdirectory as Home.
- Saving a Home also persists one active Home identity in `providers.db`;
  startup restores that identity so no-explicit-root defaults follow the last
  saved Home. The per-environment preferences remain independent, and this
  active pointer must never override an explicit Hook or history root.

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
- Multi-key import deduplication uses the source label plus an in-memory
  credential digest; it must never use a masked display value, because distinct
  short credentials can share the same mask. After deduplication, duplicate
  source labels receive deterministic numeric suffixes so the native schema's
  per-provider label uniqueness cannot discard a distinct credential; the same
  normalized labels must be used by preview and commit. Source keys are sorted
  by their source `sort_index` before this normalization, with deterministic
  tie-breakers.

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
- History source shape checks for WSL UNC locations must use the same WSL-aware
  existence probe as root validation; never call host `Path::is_dir/is_file`
  for a WSL path.
- CCS import WSL source probes and read-only snapshot commands must use the
  shared bounded subprocess helper; a stopped or unhealthy WSL distribution
  must return an import error instead of blocking the settings UI.
- Worktree/project/global precedence and launch snapshots work with CCS absent.
- Single/multi-key CCS import is previewable, idempotent and has no heuristic
  reference fallback.

## Acceptance closeout boundary (2026-08-03)

- Windows-side Rust and TypeScript checks are not evidence of a real WSL write/import run. If `wsl.exe --status` or `--list --quiet` cannot provide a working distribution and Python SQLite runtime, the WSL acceptance items remain `BLOCKED`.
- The three global writers, compensation, journal recovery, external-modification protection, and Home/Hook/History alignment require a real writable Home run in addition to unit tests; unit tests must not be reported as that manual evidence.
- Native production runtime must retain only the read-only CCS import adapter. No production path may call CCS list/prepare/reset/switch operations after cutover.

## Common configuration validation command (2026-08-04)

- `provider_common_config_validate` accepts the same `CommonConfigSetInput` as
  `provider_common_config_set` and returns no document or secret data.
- It validates app type, expected format, JSON object shape, TOML syntax and
  managed-secret exclusion without opening a write transaction or changing the
  `settings` row.
- `provider_common_config_set` calls the same repository validator before its
  database write; validate and save therefore cannot drift in accepted syntax.

## Provider editor and current-state feedback contract (2026-08-04)

### 1. Scope / Trigger

- Trigger: provider create/edit now accepts a provider-specific JSON/TOML
  document, and `provider_global_current` must recognize an already materialized
  Home even when `providers.is_current` was never committed by CLI-Manager.

### 2. Signatures

- `provider_catalog_update(input: ProviderUpdateInput) -> ProviderDetail`
- `provider_global_current(input: GlobalCurrentInput) -> GlobalCurrent`
- Internal `merge_settings_config_update(app_type, existing, incoming)` keeps
  the persisted JSON envelope while validating the nested Codex/Grok TOML.

### 3. Contracts

- Update input may contain `settingsConfig`; Claude uses a JSON object, Codex
  and Grok Build use `{ "config": "<TOML>" }` plus any existing envelope fields.
- Existing JSON secret fields and TOML secret paths remain owned by the key
  manager. A provider document edit may change non-secret fields only.
- Current detection scans active-key candidates for a plan whose every target
  live byte sequence equals its desired byte sequence. Exact materialized match
  takes precedence over a stale `is_current` flag; the flag remains a fallback
  for drift, missing-key and unavailable states.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Incoming settings is not a JSON object | `provider_settings_must_be_object` |
| Claude document is invalid JSON | `provider_settings_invalid_json` |
| Codex/Grok nested config is invalid TOML | `provider_config_invalid` |
| Existing TOML secret cannot be safely preserved | `provider_document_secret_edit_requires_key_manager` |
| Exact target match found | current provider name/id with `applied` state |
| Only database current flag found | current provider with computed drift/key-missing/unavailable state |
| No match and no current flag | `not_set` |

### 5. Good / Base / Bad Cases

- Good: edit Codex `config.toml` model while its API key is redacted; the
  model changes and the stored key remains byte-for-byte unchanged.
- Base: imported Home files match one active-key provider even when all
  database `is_current` flags are zero; current status names that provider.
- Bad: trust the masked key returned to the frontend and overwrite the real
  key with `***` or `[REDACTED]`.
- Bad: identify current only from `providers.is_current` after an external or
  CCS-created configuration already exists on disk.

### 6. Tests Required

- Repository unit tests assert JSON and TOML key-manager-owned secrets survive
  provider document updates while non-secret fields change.
- Global unit tests assert a plan matches only when every target matches and
  rejects a single changed target.
- Runtime acceptance must still verify actual local/WSL target recognition,
  external modification protection, compensation and journal recovery.

### 7. Wrong vs Correct

#### Wrong

```text
incoming.settingsConfig -> normalize -> UPDATE providers
provider_global_current -> SELECT ... WHERE is_current = 1
```

#### Correct

```text
incoming settings -> preserve key-manager-owned JSON/TOML secrets
  -> validate envelope and nested format -> UPDATE providers
global current -> build each active-key plan -> compare every target
  -> exact file match first, database flag fallback for drift reporting
```

## 8. Global apply display and preflight contract (2026-08-04)

- `ProviderHomeState.homePath` is the parent Home directory. Confirmation UI
  must select the app-specific target root from `ProviderHomeState.targets`;
  it must not present `homePath` as the actual Claude/Codex/Grok write target.
- The explicit preview action is optional at the UI boundary. When the user
  clicks Apply without an existing preview, the frontend must obtain a fresh
  `GlobalPreview` and use its fingerprint with `provider_global_apply`.
- The backend apply command continues to require a fingerprint. This keeps
  locks, live-file conflict detection, staging, verification, compensation and
  journal recovery unchanged while removing only the user-facing click-order
  requirement.

## Provider advanced metadata and generated documents (2026-08-04)

- The existing provider `settingsConfig` envelope may contain an `advanced`
  object for Codex/Grok maintenance metadata. Repository update/merge paths
  round-trip unknown envelope fields; they must not be interpreted as secret
  material or silently discarded.
- Runtime materializers consume only CLI-recognized typed fields and the nested
  provider document. The frontend-generated Claude JSON, Codex TOML and Grok
  TOML are seed documents for an empty provider record; backend validation and
  key-manager-owned secret projection remain authoritative on save/apply.
- No IPC signature or writer contract changes are required for this metadata.
  Global writers continue to use existing target-specific config files,
  fingerprint checks, compensation and journal recovery.

## Scenario: Provider model discovery and generated target documents (2026-08-05)

### 1. Scope / Trigger

- Trigger: fetching models from a persisted Claude/Codex/Grok provider or
  materializing global/project provider files after common-config merge.

### 2. Signatures

```text
provider_fetch_models(input: FetchModelsInput) -> FetchModelsResult
FetchModelsInput = { appType, providerId, baseUrl, isFullUrl?, apiFormat?, apiKeyField? }
FetchModelsResult = { models: string[] }
```

### 3. Contracts

- The backend resolves the enabled active key; plaintext never crosses the IPC
  response. Standard Base URLs append `/v1/models`; a full URL is used exactly.
- Model responses accept an array, `data[]`, or `models[]`; string entries and
  object `id`/`name` entries are trimmed, sorted and deduplicated.
- Claude project snapshots serialize the complete effective JSON after common
  merge and key projection. Do not pass it through the partial global writer.
- Codex writes plaintext only to root-level `auth.json.OPENAI_API_KEY`.
  `config.toml` contains no API key or `env_key`; endpoint/wire fields belong
  under `[model_providers.<name>]`, never at the TOML root.

### 4. Validation & Error Matrix

| Condition | Error |
| --- | --- |
| Missing enabled active key | `provider_models_active_key_required` |
| Empty Base URL | `provider_models_base_url_required` |
| Request/timeout failure | `provider_models_request_failed` |
| Non-JSON response | `provider_models_invalid_response` |
| Non-success HTTP | `provider_models_http_<status>` |
| Empty/unsupported list | `provider_models_empty` |

### 5. Good / Base / Bad Cases

- Good: `/v1/models` returns duplicate IDs; the UI receives one sorted entry
  per ID and no credential.
- Base: an existing provider without an active key remains editable but model
  discovery returns a stable error.
- Bad: put the Codex key or `env_key` in `config.toml`, nest it under an `auth`
  object in `auth.json`, or drop common fields from a Claude snapshot.

### 6. Tests Required

- Unit-test full/base URL construction and all accepted model list shapes.
- Assert Claude snapshot bytes retain both common and provider fields.
- Assert Codex auth is root-level `OPENAI_API_KEY`; config removes root endpoint
  aliases, secrets and `env_key` while preserving unowned MCP/Hook sections.

### 7. Wrong vs Correct

#### Wrong

```text
config.toml: env_key = "CLI_MANAGER_PROVIDER_KEY"
auth.json: { "auth": { "OPENAI_API_KEY": "..." } }
```

#### Correct

```text
auth.json: { "OPENAI_API_KEY": "..." }
config.toml: model_provider + [model_providers.<name>] without credentials
```

## Scenario: Codex scoped providers preserve the real Home (2026-08-06)

### 1. Scope / Trigger

- Trigger: launching or resuming local Codex with the native global provider,
  a project override, a Worktree override, or an explicit restored provider.
- `CODEX_HOME` owns config, Hooks, MCP, sandbox policy, plugins, skills,
  project trust and sessions. It is not a provider-only config path.

### 2. Signatures

```text
provider_scope_prepare(input: ScopePrepareInput) -> ProviderLaunchSnapshot?
ProviderLaunchSnapshot.configOverrides: string[]
ProviderLaunchConfig = { appType, providerId, snapshotId, claudeSettingsPath?, generatedHome?, grokModel? }
```

### 3. Contracts

- Codex global resolution returns `null`: global apply already materialized the
  provider into the selected real Home, so launch must not create a snapshot
  or override `CODEX_HOME`.
- Codex project/Worktree/explicit resolution returns a snapshot containing a
  secret key file plus non-secret `-c` overrides for only `model`,
  `model_provider` and the selected `model_providers` entry. It must not create
  generated `auth.json`, `config.toml` or `generatedHome`.
- PTY preparation validates the snapshot manifest, injects the active key as
  `CLI_MANAGER_PROVIDER_KEY`, and leaves `CODEX_HOME` unchanged.
- The frontend appends each override as a separate quoted `-c` argument only
  to a direct Codex command. SSH continues to discard local provider launch
  data.
- Persisted legacy Codex snapshots with `generatedHome` or without
  `configOverrides` are released and rebuilt before a recreated PTY starts.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Global Codex provider | `provider_scope_prepare` returns `null`; use real Home |
| Scoped Codex command is not direct | `provider_codex_command_unsupported`; release snapshot |
| Override contains quotes, control or shell interpolation characters | `provider_config_invalid` / `provider_codex_override_invalid` |
| Snapshot carries legacy Codex `generatedHome` | `provider_snapshot_mismatch` |
| Missing/empty snapshot key | `provider_snapshot_missing` / `provider_snapshot_invalid` |

### 5. Good / Base / Bad Cases

- Good: a project override changes endpoint/model/key while the real Home MCP,
  Hook, `danger-full-access` sandbox and sessions remain available.
- Base: follow-global launches with no provider snapshot and uses the files
  written by global apply.
- Bad: point `CODEX_HOME` at a generated directory containing only
  `auth.json` and `config.toml`; this hides Hooks, MCP, sandbox and history.

### 6. Tests Required

- Assert global Codex selection is passthrough and project/Worktree sources
  still materialize scoped launch data.
- Assert scoped snapshots create no Codex Home, expose no secret in DTO
  overrides, and keep the key only in the protected snapshot file/environment.
- Assert direct new/resume commands receive quoted `-c` values, unsupported
  commands fail closed, and shell interpolation characters are rejected.
- Type-check all launch DTO consumers and run provider module Rust tests.

### 7. Wrong vs Correct

#### Wrong

```text
provider scope -> generated/codex/{auth.json,config.toml}
  -> CODEX_HOME=generated/codex -> Hooks/MCP/sandbox/sessions disappear
```

#### Correct

```text
global -> real Home files, no snapshot
project/Worktree -> real CODEX_HOME + non-secret `-c` overrides
  + active key in PTY child environment
```

## Scenario: Grok scoped providers preserve the real Home (2026-08-06)

### 1. Scope / Trigger

- Trigger: launching local Grok Build with a native global provider, project
  override, Worktree override, or explicit restored provider.
- `GROK_HOME` owns Hook, MCP, sessions, skills, plugins and other user state;
  it is not a provider-only configuration path.

### 2. Signatures

```text
ProviderLaunchSnapshot.grokModel: string?
PTY environment: GROK_MODELS_BASE_URL + XAI_API_KEY
startup command: grok --model <validated-model> ...
```

### 3. Contracts

- Every Grok provider scope keeps the resolved real Home and returns a
  releasable snapshot containing a secret key file plus manifest-validated
  Base URL/model metadata. It must not create a generated Grok Home or set
  `GROK_HOME` in child-process overrides.
- PTY preparation validates provider/snapshot/model identity before reading the
  key and injecting `GROK_MODELS_BASE_URL` plus `XAI_API_KEY`.
- The frontend replaces any existing `-m`/`--model` argument with one safely
  quoted `--model` value on direct Grok commands. Model IDs accept only the
  bounded identifier character set; unsupported wrapper commands fail closed.
- Persisted legacy Grok snapshots with `generatedHome` or without `grokModel`
  are released and rebuilt before PTY recreation.
- SSH continues to discard local provider snapshots and secrets.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Snapshot contains a generated Grok Home | `provider_snapshot_mismatch` |
| Manifest lacks Base URL/model or key | `provider_snapshot_invalid` / `provider_snapshot_missing` |
| DTO model differs from manifest | `provider_snapshot_mismatch` |
| Startup command is not direct Grok | `provider_grok_command_unsupported`; release snapshot |
| Model contains whitespace, quotes, controls or shell metacharacters | `provider_grok_model_invalid` |

### 5. Good / Base / Bad Cases

- Good: two Worktree terminals select different Grok providers; each receives
  its own endpoint/key/model while both read the same real Hook/MCP/history.
- Base: a global provider uses the same process override mechanism and leaves
  the already materialized real Home intact.
- Bad: point `GROK_HOME` at a snapshot containing only `config.toml`; this
  hides Hook, MCP, sessions, skills and realtime history consumers.

### 6. Tests Required

- Assert Grok snapshot creation writes no generated Home/config and returns the
  selected model with manifest Base URL/model metadata.
- Assert PTY environment injection preserves an existing `GROK_HOME` while
  replacing endpoint/key only.
- Assert command handling replaces existing model flags, rejects wrapper and
  unsafe model input, and keeps resume arguments.

### 7. Wrong vs Correct

#### Wrong

```text
provider scope -> generated/grokbuild/<snapshot>/grok/config.toml
  -> GROK_HOME=generated/grokbuild/<snapshot>/grok
  -> real Hook/MCP/sessions/skills disappear
```

#### Correct

```text
provider scope -> manifest(base URL/model) + protected key file
  -> real GROK_HOME unchanged
  -> GROK_MODELS_BASE_URL + XAI_API_KEY + grok --model <model>
```
