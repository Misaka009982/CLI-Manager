import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Check, Clock, Folder, Hash } from "../../../shared/ui/icons";
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
  disabled?: boolean;
  folder?: {
    paths: readonly string[];
    path: string;
    onPathChange: (path: string) => void;
    sourceLabel: string;
    explicit: boolean;
    onReset: () => Promise<void>;
  };
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
export function FileTreeSortMenu({ settings, onChange, portalContainer, disabled = false, folder }: FileTreeSortMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // 每次打开恢复可见末级；保存中仍允许关闭并聚焦箭头，但不能再次打开。
  const changeOpen = (next: boolean) => {
    if (next && (disabled || savingRef.current)) return;
    setOpen(next);
    if (folder) folder.onPathChange(folder.paths[folder.paths.length - 1]);
  };

  const currentKeyLabel = t(settings.key === "date" ? "files.sort.byDate" : "files.sort.byName");
  const directionLabel = (direction: FileTreeSortDirection) => t(settings.key === "date"
    ? direction === "descending" ? "files.sort.newestFirst" : "files.sort.oldestFirst"
    : direction === "descending" ? "files.sort.descending" : "files.sort.ascending");
  const menuLabel = folder ? t("files.sort.folder", { path: folder.path }) : t("files.sort.label");
  const tooltip = `${menuLabel} · ${currentKeyLabel} · ${directionLabel(settings.direction)}${folder ? ` · ${folder.sourceLabel}` : ""}`;

  // 保存前固定回调目标；卸载后的回执不能关闭新作用域菜单或弹出旧错误。
  const saveSort = async (save: () => Promise<void>) => {
    if (disabled || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await save();
      if (mountedRef.current) changeOpen(false);
    } catch (error) {
      if (mountedRef.current) toast.error(t("files.sort.saveFailed"), { description: String(error) });
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };
  const selectSort = (change: FileTreeSortChange) => saveSort(() => onChange(change));

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
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={folder ? "ui-file-tooltip ui-icon-action ui-folder-sort-trigger" : "ui-file-tooltip ui-icon-action"}
          data-sort-overridden={folder?.explicit ? "true" : undefined}
          data-sort-direction={settings.direction}
          data-tooltip={tooltip}
          aria-label={tooltip}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-busy={saving}
          aria-disabled={disabled || saving || undefined}
          disabled={disabled || (!folder && saving)}
        >
          {settings.direction === "descending" ? <ArrowDown size={13} aria-hidden="true" /> : <ArrowUp size={13} aria-hidden="true" />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="end"
        side="bottom"
        collisionPadding={8}
        portalContainer={portalContainer}
        role="menu"
        data-folder-sort-control={folder ? "true" : undefined}
        aria-label={menuLabel}
        aria-busy={saving}
        className="workspace-layout-menu ui-glass w-60 max-w-[calc(100vw-16px)] p-1.5"
        onKeyDown={handleMenuKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
        }}
      >
        {folder && (
          <>
            <div className="px-2 py-1 text-xs break-all" title={folder.path}>{folder.path}</div>
            <div className="px-2 pb-1 text-xs text-text-muted" role="status">{folder.sourceLabel}</div>
            {folder.paths.length > 1 && (
              <div role="group" aria-label={t("files.sort.target")}>
                <div className="workspace-layout-menu-section">{t("files.sort.target")}</div>
                {folder.paths.map((path) => (
                  <SortMenuButton key={path} icon={<Folder size={14} aria-hidden="true" />}
                    checked={folder.path === path} disabled={disabled || saving} onClick={() => folder.onPathChange(path)}>
                    {path}
                  </SortMenuButton>
                ))}
              </div>
            )}
          </>
        )}
        <div role="group" aria-label={t("files.sort.label")}>
          <div className="workspace-layout-menu-section">{t("files.sort.label")}</div>
          {SORT_KEYS.map((option) => (
            <SortMenuButton
              key={option.value}
              icon={option.icon}
              checked={settings.key === option.value}
              disabled={disabled || saving}
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
              disabled={disabled || saving}
              onClick={() => void selectSort({ direction: option.value })}
            >
              {directionLabel(option.value)}
            </SortMenuButton>
          ))}
        </div>
        {folder && (
          <button type="button" role="menuitem" className="workspace-layout-menu-item ui-focus-ring"
            disabled={disabled || saving || !folder.explicit} onClick={() => void saveSort(folder.onReset)}>
            {t("files.sort.inherit")}
          </button>
        )}
        {saving && <div role="status" className="px-2 py-1 text-xs text-text-muted">{t("files.sort.saving")}</div>}
      </PopoverContent>
    </Popover>
  );
}
