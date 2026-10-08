import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Check, Clock, Hash } from "../../../shared/ui/icons";
import { useI18n, type TranslationKey } from "../../../shared/i18n/index";
import { Popover, PopoverContent, PopoverTrigger } from "../../../shared/ui/popover";
import type {
  FileTreeSortChange,
  FileTreeSortDirection,
  FileTreeSortKey,
  FileTreeSortSettings,
} from "../../../shared/lib/fileTreeSort";

interface FileTreeSortMenuProps {
  settings: FileTreeSortSettings;
  onChange: (change: FileTreeSortChange) => Promise<void>;
  /** 面板模式下复用文件面板的菜单挂载点，保证配色变量生效。 */
  portalContainer?: HTMLElement | null;
}

const SORT_KEYS: Array<{ value: FileTreeSortKey; labelKey: TranslationKey; icon: ReactNode }> = [
  { value: "name", labelKey: "files.sort.byName", icon: <Hash size={14} aria-hidden="true" /> },
  { value: "date", labelKey: "files.sort.byDate", icon: <Clock size={14} aria-hidden="true" /> },
];

const SORT_DIRECTIONS: Array<{ value: FileTreeSortDirection; icon: ReactNode }> = [
  { value: "ascending", icon: <ArrowUp size={14} aria-hidden="true" /> },
  { value: "descending", icon: <ArrowDown size={14} aria-hidden="true" /> },
];

/** 菜单内可聚焦的单选项，方向键导航与 WorkspaceLayoutMenu 保持一致。 */
function SortMenuButton({
  children,
  icon,
  checked,
  disabled,
  onClick,
}: {
  children: ReactNode;
  icon: ReactNode;
  checked: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      disabled={disabled}
      className="workspace-layout-menu-item ui-focus-ring"
      data-selected={checked ? "true" : "false"}
      onClick={onClick}
    >
      <span className="workspace-layout-menu-item-icon" aria-hidden="true">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      {checked && <Check size={14} aria-hidden="true" />}
    </button>
  );
}

/**
 * 文件树排序菜单：维度（名称/修改日期）与方向（升/降）各自单选。
 * 仅影响文件树本身的渲染顺序，不改动后端排序或搜索结果。
 */
export function FileTreeSortMenu({ settings, onChange, portalContainer }: FileTreeSortMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const currentKeyLabel = t(settings.key === "date" ? "files.sort.byDate" : "files.sort.byName");
  const directionLabel = (direction: FileTreeSortDirection) => t(settings.key === "date"
    ? direction === "descending" ? "files.sort.newestFirst" : "files.sort.oldestFirst"
    : direction === "descending" ? "files.sort.descending" : "files.sort.ascending");
  const tooltip = `${t("files.sort.label")} · ${currentKeyLabel} · ${directionLabel(settings.direction)}`;

  const selectSort = async (change: FileTreeSortChange) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await onChange(change);
      setOpen(false);
    } catch (error) {
      toast.error(t("files.sort.saveFailed"), { description: String(error) });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')
    );
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : currentIndex < 0
        ? event.key === "ArrowDown" ? 0 : items.length - 1
        : (currentIndex + offset + items.length) % items.length;
    event.preventDefault();
    event.stopPropagation();
    items[nextIndex]?.focus();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="ui-file-tooltip ui-icon-action"
          data-tooltip={tooltip}
          aria-label={tooltip}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-busy={saving}
          disabled={saving}
        >
          {settings.direction === "descending" ? <ArrowDown size={13} aria-hidden="true" /> : <ArrowUp size={13} aria-hidden="true" />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        collisionPadding={8}
        portalContainer={portalContainer}
        role="menu"
        aria-label={t("files.sort.label")}
        aria-busy={saving}
        className="workspace-layout-menu ui-glass w-60 max-w-[calc(100vw-16px)] p-1.5"
        onKeyDown={handleMenuKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)
            ?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')
            ?.focus();
        }}
      >
        <div role="group" aria-label={t("files.sort.label")}>
          <div className="workspace-layout-menu-section">{t("files.sort.label")}</div>
          {SORT_KEYS.map((option) => (
            <SortMenuButton
              key={option.value}
              icon={option.icon}
              checked={settings.key === option.value}
              disabled={saving}
              onClick={() => void selectSort({ key: option.value })}
            >
              {t(option.labelKey)}
            </SortMenuButton>
          ))}
        </div>
        <div role="group" aria-label={t("files.sort.direction")}>
          <div className="workspace-layout-menu-section">{t("files.sort.direction")}</div>
          {SORT_DIRECTIONS.map((option) => (
            <SortMenuButton
              key={option.value}
              icon={option.icon}
              checked={settings.direction === option.value}
              disabled={saving}
              onClick={() => void selectSort({ direction: option.value })}
            >
              {directionLabel(option.value)}
            </SortMenuButton>
          ))}
        </div>
        {saving && <div role="status" className="px-2 py-1 text-xs text-text-muted">{t("files.sort.saving")}</div>}
      </PopoverContent>
    </Popover>
  );
}
