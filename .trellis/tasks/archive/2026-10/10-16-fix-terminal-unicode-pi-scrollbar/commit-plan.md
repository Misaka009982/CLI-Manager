# Approved commit

`fix(terminal): unify grapheme widths across desktop and web (Refs #285, #286)`

- src/shared/lib/terminalUnicode.ts
- src/features/terminal/hooks/useXTermController.ts
- apps/web/src/WebTerminal.tsx
- package.json
- apps/web/package.json
- package-lock.json
- scripts/terminalUnicode.test.mjs
- scripts/terminalPiCompatibility.test.mjs
- docs/功能清单.md
- CHANGELOG.md
- .trellis/spec/frontend/terminal-font-external-program-contracts.md
- .trellis/spec/frontend/index.md
- .trellis/tasks/10-16-fix-terminal-unicode-pi-scrollbar/ (reviewed planning and validation artifacts)

No unrecognized dirty files. User-local Pi settings/backup and generated dist are excluded.
User confirmed validation complete and approved committing on 2026-10-16, then requested removal of the standalone compatibility document. That file and its links are excluded from this final scope.
No push. Do not generalize the verification to all fonts or glyph-overdraw symptoms.
