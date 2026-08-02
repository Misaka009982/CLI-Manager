# Native Provider Management Contracts

## Scenario: Persist providers and manually selected keys without cc-switch

### 1. Scope / Trigger

- Trigger: creating, editing, duplicating, enabling, disabling, or deleting a native Claude Code, Codex, or Grok Build provider or one of its keys.
- Goal: CLI-Manager owns the provider catalog and plaintext key storage; cc-switch is not read by native CRUD commands.
- Excluded from this contract: global Home materialization, project/Worktree launch preparation, automatic key rotation, key validation, quota checks, and CCS import.

### 2. Persistence contract

- Durable data lives in the stable `cli-manager.db` resolved by `app_paths::db_path()`.
- `managed_providers.cli_type` is exactly `claude`, `codex`, or `grok`.
- Provider names are trimmed, non-empty, and unique per CLI type using a normalized case-insensitive database key.
- Provider config is non-secret text: JSON for Claude and TOML for Codex/Grok.
- `managed_provider_keys.secret_text` stores the user input verbatim in plaintext. This is the only authoritative provider-key column.
- Key label is trimmed and non-empty. A key has a masked hint and SHA-256 fingerprint derived in Rust.
- A partial unique index enforces at most one active key per provider.
- Foreign keys are enabled; deleting an unreferenced provider cascades to its keys.
- Global/import/issues/journal tables are created with the native schema so later phases do not require incompatible bootstrap tables, but Phase 1 CRUD does not write global live state.
- Migration compatibility: version 25 is reserved for the previously shipped `providers/provider_keys` prototype and its SQL/checksum must remain immutable; the native `managed_*` schema is introduced by version 26. Never reuse an applied migration version for a different provider schema.

### 3. Provider state machine

```text
create -> draft
draft + first key -> ready (the first key becomes active)
ready + add key -> ready (existing active key is unchanged)
ready <-> disabled only when no global/project/worktree reference exists
```

- `draft` may have no key and cannot be selected by any scope.
- `ready` has at least one key and exactly one active key.
- `disabled` retains keys but cannot be selected. Disabling a referenced provider returns its reference summary and makes no change.
- Deleting a referenced provider is rejected. Phase 1 checks native global-state references and v2 project/Worktree references; legacy CCS-shaped overrides do not become native references by name or UUID guesswork.
- Deleting an active key requires a valid replacement key belonging to the same provider. Activation and replacement deletion run inside `BEGIN IMMEDIATE`.
- No command performs background activation, health checks, rotation, retry, or failover.

### 4. Secret boundary

- Create/replace requests may carry plaintext `secret`; read DTOs never contain `secret`, `secret_text`, config-projected credentials, or reversible encodings.
- Key DTOs expose only `hasSecret`, `secretHint`, and `fingerprint`.
- Provider list/get DTOs may include non-secret `configText` and key DTOs.
- Errors use stable codes and field names, never user config bodies or secret values.
- WebDAV payloads, ordinary export, logs, diagnostics, journals, React state, and toast descriptions must not contain plaintext keys.
- Update semantics are explicit: `keep` preserves the stored secret, `replace` requires a new non-empty secret. A masked hint is never accepted as a replacement secret.

### 5. Configuration engine

- Claude config must parse as a JSON object. Codex/Grok config must parse as a TOML table/document.
- Effective config order is common config, then provider config. JSON objects/TOML tables merge recursively; arrays and scalar assignments replace; JSON `null` is an explicit provider override.
- `inheritCommon=false` skips common config.
- Common and provider config reject embedded secret values under secret-bearing keys. `env_key` is a non-secret routing field and is allowed.
- Validation is authoritative in Rust. The frontend may offer editor hints but cannot bypass Rust validation.
- Phase 1 effective preview is redacted and excludes the active key projection; actual CLI identity/key projection belongs to later adapters.

### 6. Tauri command contract

All serialized DTO fields use camelCase.

```text
provider_list(cliType?) -> ProviderSummary[]
provider_get(id) -> ProviderDetail
provider_create(input) -> ProviderDetail
provider_update(id, patch) -> ProviderDetail
provider_duplicate(id) -> ProviderDetail
provider_delete(id) -> void
provider_set_status(id, status) -> ProviderDetail

provider_key_create(providerId, input) -> ProviderDetail
provider_key_update(providerId, keyId, input) -> ProviderDetail
provider_key_activate(providerId, keyId) -> ProviderDetail
provider_key_delete(providerId, keyId, replacementKeyId?) -> ProviderDetail

provider_common_get(cliType) -> ProviderCommonConfig
provider_common_update(cliType, configText) -> ProviderCommonConfig
provider_validate_config(input) -> ProviderConfigValidation
provider_preview_effective(providerId) -> ProviderEffectivePreview
```

- IDs are generated in Rust. Caller-supplied provider/key IDs are not accepted on create.
- Every command validates string length, enum values, ownership, and cross-record identity at the Rust boundary.
- Commands open the stable application database with foreign keys enabled and a bounded busy timeout.

### 7. Stable error codes

| Condition | Error |
|---|---|
| Unsupported CLI type | `provider_cli_type_invalid` |
| Blank/oversized name | `provider_name_invalid` |
| Duplicate normalized name | `provider_name_conflict` |
| Provider missing | `provider_not_found` |
| Provider referenced | `provider_referenced` |
| Invalid status transition | `provider_status_invalid` |
| Invalid JSON/TOML | `provider_config_invalid` |
| Secret embedded in config | `provider_config_contains_secret` |
| Blank/oversized key label | `provider_key_label_invalid` |
| Empty replacement secret | `provider_key_secret_invalid` |
| Key missing/wrong provider | `provider_key_not_found` |
| Active key deletion without replacement | `provider_key_replacement_required` |
| Database unavailable | `provider_database_open_failed` |
| Database operation failed | `provider_database_query_failed` |

### 8. Required tests

- Migration creates all native tables, checks, foreign keys, name uniqueness, and active-key partial unique index.
- Provider create/update/duplicate/delete for all three CLI types without a CCS database.
- First key becomes active and promotes draft to ready; later keys remain inactive.
- Concurrent/manual activation cannot leave two active keys.
- Active-key delete requires a same-provider replacement and is atomic.
- Read DTO serialization contains no plaintext secret or `secretText` property.
- JSON/TOML parsing, recursive merge, array replacement, JSON null, `inheritCommon=false`, and secret-field rejection.
- Referenced provider disable/delete is rejected without mutation.

## Good / Base / Bad cases

- Good: CCS is missing; the user creates a Codex provider with two keys and manually activates the second. Native list/get continues to work.
- Base: a draft provider with no key remains editable but unavailable for scope selection.
- Bad: returning a stored key to the WebView to prefill an edit form.
- Bad: resolving identity by matching a legacy CCS provider name.
- Bad: catching a uniqueness error only in React; database and Rust validation are authoritative.

### Common Mistake: using `Value::from_str` for multi-line TOML documents

`toml::Value`'s `FromStr` path can reject a valid multi-line document emitted by
`toml::to_string_pretty`. Use `toml::from_str::<toml::Value>(text)` for both
incoming TOML and effective-preview assertions. Keep a regression test with a
nested table and a scalar assignment after that table.
