# Native Provider Management Contracts

## Scenario: Manage native providers and manual multi-key state

### 1. Data flow

```text
Provider settings UI
  -> providerStore typed action
  -> Tauri provider_* command
  -> Rust validation/transaction
  -> redacted ProviderDetail DTO
  -> providerStore replaces authoritative snapshot
```

- `providerStore` owns the loaded native catalog, selected CLI type/provider, loading flags, and redacted command errors.
- Plaintext key input is component-local and write-only. It is cleared after success, cancel, provider change, and component unmount.
- The store never persists plaintext keys and never synthesizes provider/key state ahead of a successful Rust response.
- Provider catalog loading does not inspect `ccSwitchDbPath`; CCS appears only as a later import action.

### 2. DTO contract

- Frontend types mirror Rust camelCase DTOs.
- `CliType` is the closed union `"claude" | "codex" | "grok"`.
- Key DTOs contain `hasSecret`, `secretHint`, and `fingerprint`, never `secret` or `secretText`.
- Provider summaries expose counts and active-key metadata sufficient for list rendering without fetching secrets.
- Stable backend error codes are translated at the UI boundary; unknown errors receive a generic localized fallback without dumping request payloads.

### 3. Settings-page interaction

- Type tabs always show Claude Code, Codex, and Grok, including zero-count types.
- The provider list supports search, create, duplicate, edit, disable/enable, and delete.
- Provider create/edit uses a themed application dialog or in-page form, not `window.prompt` / `window.confirm`.
- Keys show label, masked hint, and one explicit active badge. There is no rotation, health, validity, quota, fallback, or automatic-switch control.
- Creating the first key makes it active. Activating another key requires an explicit confirmation that new launches will use it; Phase 1 does not write global CLI files.
- Deleting the active key requires choosing another existing key. When no replacement exists, the UI explains why deletion is unavailable.
- Provider config offers inherit-common, raw config text, Rust validation feedback, and a read-only effective preview.
- “Import from CC Switch” is visible as a disabled/placeholder action until the import phase; native CRUD remains usable when CCS is absent.
- A one-time localized notice states that provider keys are plaintext in the local SQLite database and are excluded from ordinary sync/export.

### 4. UI state and accessibility

- Search and form draft state stay local to the provider page/editor. Server snapshots and mutations stay in `providerStore`.
- Every mutation has disabled/loading feedback and prevents duplicate submission.
- Destructive actions use `useAppConfirm`; text entry uses labeled fields.
- Status is expressed with text plus color/icon. Keyboard focus follows visual order and returns to a sensible list item after delete.
- All visible copy, toast, empty state, tooltip, and aria label has `zh-CN` and `en-US` translations; `zh-TW` follows the project conversion path.
- The page remains a master-detail layout and avoids whole-store subscriptions.

### 5. Error behavior

| Error | UI behavior |
|---|---|
| `provider_name_conflict` | Focus name field and keep draft. |
| `provider_config_invalid` | Focus config editor and show localized parse message. |
| `provider_config_contains_secret` | Explain that keys belong in the Keys section. |
| `provider_referenced` | Keep provider selected and show returned reference summary when available. |
| `provider_key_replacement_required` | Open/retain replacement selection; do not retry automatically. |
| Database unavailable/query failure | Keep last successful snapshot, show retry action, never show request payload. |

### 6. Required tests and checks

- Store command payloads use camelCase and never retain plaintext key input.
- Provider list/filter selection stays valid after create/delete/type switch.
- Manual key activation replaces the authoritative detail snapshot and exposes exactly one active badge.
- Active key deletion cannot submit without a replacement.
- CCS missing has no effect on native catalog loading.
- `zh-CN` / `en-US` copy exists for every new key.
- Run `npx tsc --noEmit`; human desktop verification covers keyboard flow, destructive confirmations, focus restoration, and both languages.

## Good / Base / Bad cases

- Good: after creating a key, the input is blank and neither Zustand nor the rendered detail contains the plaintext value.
- Base: an empty type shows a create action and import placeholder rather than a CCS connection error.
- Bad: storing the key in `providerStore` so the editor can redisplay it.
- Bad: optimistically marking key B active before Rust commits the transaction.
