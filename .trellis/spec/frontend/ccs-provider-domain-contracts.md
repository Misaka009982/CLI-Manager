# CCS-Compatible Provider Domain UI Contracts

> Planned frontend contract for task `08-02-key`. It replaces the removed
> minimal native-provider form and is intentionally a complete configuration
> experience.

## Screen structure

The Provider Settings page is a master/detail workspace:

1. CLI type tabs: Claude Code, Codex, Grok Build.
2. Global-current strip: selected Home, current provider, active key state,
   preview/apply action.
3. Catalog pane: search, import CCS, environment check, add, reorderable
   provider cards, current/draft/disabled/reference badges.
4. Editor pane: provider metadata, endpoint/API request URL, model/model
   provider, status, multi-key, type-common inheritance, raw documents,
   effective/live diff, advanced panels and save/apply actions.

Provider cards always show provider name, base URL, selected model, key count/
active label and state. The initial form must not hide URL, key or model in a
generic configuration textarea.

## Complete editor contract

- Claude has a full `settings.json` editor.
- Codex has independent full `auth.json` and `config.toml` editors,
  including MCP/hooks/projects/features/unknown config. Typed helper controls
  include API base/request URL, `model`, `model_provider` and provider
  fields.
- Grok Build has a full `config.toml` editor with endpoint and selected model.
- All types have Name, Note, Website, enable/current state, model visibility,
  advanced settings, validation, effective configuration and live diff.
- Helper field changes and raw-document changes round-trip only through
  backend parser/patch results. A syntax error retains the local draft and
  blocks destructive overwrite.
- Common config opens from the current **type**, not selected provider. The
  provider’s inherit switch identifies its origin and effective precedence.
- The UI includes source/common/provider/effective/live-diff labels and
  communicates provider-over-common field precedence.

## Key interaction contract

- A key row exposes label, note/tags, enabled state, masked hint, active badge,
  and explicit actions: add, edit, reveal, activate, disable/delete, reorder.
- Manual activation is the only selection mechanism. The screen contains no
  auto-switch, health, validity, quota, retry, cooldown, rotation or failover
  wording/control.
- Key creation/replacement input is local component state, password-masked,
  cleared after every terminal action and never persisted in Zustand/local
  storage.
- Plaintext database storage is disclosed. Explicit reveal/auth-document view
  may show the selected credential as a product choice, but the resulting
  response must not become a durable store snapshot, toast, analytics payload
  or debug log.
- Deleting/disabling active key needs a replacement/explicit draft confirmation.
  Do not select another key optimistically.

## Global, scope, Home, and import interactions

- Global apply is an explicit preview -> confirmation -> progress -> verified
  result flow. It tells users it writes the selected Home’s real CLI files and
  applies to new CLI processes only.
- The project/Worktree selector lists native providers and visibly resolves
  Worktree > project > global. Reset means follow the next lower scope.
- Home selection offers auto, choose folder, paste absolute path and reset.
  It shows derived Claude/Codex/Grok live/config/history/Hook paths and warns
  if a feature has an explicit root not following Home. It never performs an
  unrequested Hook install/uninstall/move.
- Environment check renders status, reason, remedy and safe open/copy actions.
  It never displays environment variable values.
- CCS import is a wizard: source selection, scan, key-consent, conflict/
  mapping preview, commit, global-apply option, and repair issue view.
  CCS absence is an import-state message, not a provider-page failure.

## State, errors, accessibility, i18n

- Server snapshots/mutations live in focused domain stores/hooks. Search,
  selection, unsaved raw-document drafts and dialogs are local UI state.
- Do not subscribe the whole settings modal to provider data. Preserve
  selection after list refresh, reorder, mutation or type switch.
- Use `useAppConfirm` for destructive/apply/key-replacement confirmation;
  do not use browser prompt/confirm.
- Every busy mutation disables duplicate submission and preserves the last
  successful snapshot on error. Stable error codes map to localized actionable
  messages; raw backend payloads are never displayed.
- Keyboard order follows screen order; cards, tabs, key rows, code editors and
  dialogs have visible focus and accessible names. Delete returns focus to a
  logical neighboring card.
- Add each string in `zh-CN` and `en-US`, including ARIA, import conflicts,
  Home alignment, apply/journal recovery and key workflow. Verify English
  keeps 24-hour time.

## Review checklist

- Compare the supplier list/editor against task prototype and supplied CCS
  screenshots. The final screen must visibly contain global selection,
  base URL, active key/multi-key, models, full raw config, type common config,
  effective config and save/apply—not just provider CRUD.
- Test 1024px/1440px widths, Chinese/English, keyboard-only use, long
  configuration documents, unsaved changes, empty type, and provider import
  errors.
