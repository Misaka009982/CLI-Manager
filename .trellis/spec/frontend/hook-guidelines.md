# Hook Guidelines

## Hooks Must Precede Visibility Guards

Components that stay mounted while hidden must call every hook before an early render return.
Changing visibility must not change hook order or hook count.

```tsx
// Wrong: hiding the panel skips a later hook.
const value = useMemo(() => buildValue(input), [input]);
if (!visible) return null;
const other = useMemo(() => buildOther(value), [value]);

// Correct: hooks run before the render guard.
const value = useMemo(() => buildValue(input), [input]);
const other = useMemo(() => buildOther(value), [value]);
if (!visible) return null;
```

Before changing tab or side-panel visibility, check for `return null` before later `use*` calls.

## Settings Escape Ownership and Shell Focus

`SettingsModal` must ignore repeated/composing/default-prevented Escape events. Holding Escape
after a child closes must not dismiss settings; require a new independent keydown. Before closing, its
document bubble listener checks both the event's composed path and currently visible
`dialog`/`alertdialog` layers. A child layer may close synchronously during window capture;
its presence in the event path still owns that Escape, even after DOM removal.

Mantine `keepMounted` drawers retain `role="dialog"` while hidden. DOM presence alone must
not block settings dismissal: use layout rectangles plus computed visibility to exclude
hidden layers (including `display:none` ancestors). An exiting/transparent transition
still owns Escape until it leaves layout. Preserve child-control `preventDefault()`.

`#main-content` and `.ui-workspace-settings-dialog` retain programmatic focus for skip links
and focus traps but suppress their own native outline. Never disable focus outlines on all
elements or remove the shells' negative tabIndex: interactive children still need keyboard
focus cues. Chromium switches a clicked shell to focus-visible when Escape is pressed.

Run `node --test scripts/settingsEscape.browser.test.mjs` (existing Playwright runtime and
Edge, or `SETTINGS_TEST_PLAYWRIGHT` / `SETTINGS_TEST_BROWSER` overrides). Cover hidden
drawers, visible and zero-duration child closes, alert dialogs, default prevention, IME, repeat,
button Tab focus, and both language/theme variants. The fixture isolates remote services;
native Tauri behavior remains a manual verification item.

The MCP editor disables Mantine's window-capture Escape handler and handles local bubbling
after controls. Combobox closes its menu without default prevention; check its target's
`data-mantine-stop-propagation` marker before closing the editor. Confirmation suspends the
editor focus trap; its own Escape cancels only the confirmation. Tests must wait for actual
focus return before sending the next independent Escape, rather than dispatching it from
an exiting hidden input.
