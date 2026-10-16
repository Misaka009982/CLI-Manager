import type { CSSProperties, ReactElement } from "react";
import { LockKeyhole } from "lucide-react";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import { useI18n } from "../../../shared/i18n";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "../../../shared/ui/context-menu";
import { setTerminalLayoutLocked } from "./terminalLayoutLock";

export function TerminalLayoutLockMenuItem() {
  const locked = useSettingsStore((s) => s.terminalLayoutLocked);
  const { t } = useI18n();
  return (
    <ContextMenuItem onSelect={() => setTerminalLayoutLocked(!locked)}>
      {t(locked ? "terminal.layoutLock.unlockLayout" : "terminal.layoutLock.lock")}
    </ContextMenuItem>
  );
}

// 外层菜单只接管空白区；不能依赖内层/DnD 是否消费事件来决定标签菜单归属。
export function TerminalLayoutLockMenu({ children, style }: { children: ReactElement; style?: CSSProperties }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={(event) => {
        if (event.target instanceof Element
          && event.target.closest("[data-terminal-tab-id], [data-workspan-id]")) event.preventDefault();
      }}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="terminal-skin" style={style}>
        <TerminalLayoutLockMenuItem />
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function TerminalLayoutLockIndicator() {
  const locked = useSettingsStore((s) => s.terminalLayoutLocked);
  const { t } = useI18n();
  if (!locked) return null;
  return (
    <button
      type="button"
      className="ui-focus-ring ui-terminal-tab-list-button mx-1 shrink-0"
      onClick={() => setTerminalLayoutLocked(false)}
      title={t("terminal.layoutLock.unlockHint")}
      aria-label={t("terminal.layoutLock.unlockHint")}
      data-terminal-layout-lock="true"
    >
      <LockKeyhole size={14} aria-hidden="true" />
    </button>
  );
}
