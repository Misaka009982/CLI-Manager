import { ActionIcon, Badge, Group, Menu, Stack, Switch, Text, Tooltip } from "@mantine/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState, type CSSProperties } from "react";
import { Boxes, ChevronDown, ChevronUp, Copy, GripVertical, MoreHorizontal, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { DND_SORTABLE_TRANSITION } from "@/lib/dragInteraction";
import { VendorIcon, inferVendor } from "../../VendorIcon";
import type { NativeProviderCard as NativeProviderCardData } from "./nativeProviderTypes";

interface NativeProviderCardProps {
  provider: NativeProviderCardData;
  selected: boolean;
  busy: boolean;
  isFirst: boolean;
  isLast: boolean;
  canReorder: boolean;
  onSelect: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onEnabledChange: (enabled: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

/**
 * 供应商目录行。
 *
 * 刻意压成单行：拖拽手柄常驻行首，主体保留「品牌图标 + 名称 + 状态点 +
 * 次要摘要 + 开关」；复制/删除等低频操作默认淡出，hover/聚焦才显形，详情
 * 一律走点击弹窗。
 * 拖拽走 @dnd-kit（与终端标签页、快捷面板一致）；HTML5 原生 draggable 在本
 * 应用 webview 里拿不到有效 dropEffect，只会画出禁用光标。
 */
export function NativeProviderCard({
  provider,
  selected,
  busy,
  isFirst,
  isLast,
  canReorder,
  onSelect,
  onDuplicate,
  onDelete,
  onEnabledChange,
  onMoveUp,
  onMoveDown,
}: NativeProviderCardProps) {
  const { t } = useI18n();
  // 菜单展开后指针通常已移出该行，若仅靠 hover/focus-within 控制显隐，
  // 触发按钮会在下拉仍然打开时淡出，所以把展开态也算进「保持显形」条件。
  const [menuOpened, setMenuOpened] = useState(false);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: provider.id, disabled: !canReorder, transition: DND_SORTABLE_TRANSITION });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    zIndex: isDragging ? 1 : undefined,
  };

  const vendor = inferVendor(`${provider.name} ${provider.model ?? ""} ${provider.baseUrl ?? ""}`);
  // 状态点与「已停用」徽章互斥表达可用性：配置无效优先级最高（黄），
  // 其次是停用（灰），再是缺少当前密钥（黄），正常为绿。
  const status = !provider.settingsValid
    ? { color: "var(--mantine-color-yellow-6)", label: t("providerCatalog.invalidConfig") }
    : !provider.enabled
      ? { color: "var(--text-muted)", label: t("providerCatalog.disabled") }
      : !provider.activeKeyLabel
        ? { color: "var(--mantine-color-yellow-6)", label: t("providerCatalog.noActiveKey") }
        : { color: "var(--mantine-color-green-6)", label: t("providerCatalog.enabled") };
  // 副行只放一条最有信息量的摘要：优先模型，退到 endpoint，都没有才提示未配置。
  const summary = provider.model || provider.baseUrl || t("providerCatalog.notConfigured");

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group/row relative flex items-center gap-1 rounded-xl border pl-1 pr-2 transition-colors ${
        selected
          ? "border-primary bg-primary/10"
          : "border-border/60 bg-surface-container-low hover:border-border hover:bg-surface-container"
      }`}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        className="ui-focus-ring flex shrink-0 items-center rounded px-0.5 text-text-muted disabled:opacity-40"
        style={{ cursor: canReorder ? (isDragging ? "grabbing" : "grab") : "not-allowed", touchAction: "none" }}
        title={t("providerCatalog.reorder")}
        aria-label={t("providerCatalog.reorder")}
        disabled={!canReorder}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} />
      </button>

      <button
        type="button"
        aria-label={t("providerCatalog.selectProvider", { name: provider.name })}
        aria-current={selected ? "true" : undefined}
        className="ui-focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left"
        onClick={onSelect}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-container-lowest">
          <VendorIcon vendor={vendor} size={16} fallback={Boxes} />
        </span>
        <Stack gap={0} className="min-w-0 flex-1">
          <Group gap={6} wrap="nowrap" className="min-w-0">
            <Text size="sm" fw={600} truncate className="min-w-0" title={provider.name}>{provider.name}</Text>
            {provider.isCurrent && (
              <Badge size="xs" color="cliPrimary" className="shrink-0">{t("providerCatalog.current")}</Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed" truncate title={summary}>{summary}</Text>
        </Stack>
        <Tooltip label={status.label} withArrow>
          <span
            role="img"
            aria-label={status.label}
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: status.color }}
          />
        </Tooltip>
      </button>

      {/* 更多操作默认淡出，hover / 键盘聚焦 / 菜单展开时才显形。拖拽手柄已常驻行首。 */}
      <Group
        gap={2}
        wrap="nowrap"
        className={`shrink-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 ${
          menuOpened || isDragging ? "opacity-100" : "opacity-0"
        }`}
      >
        <Menu position="bottom-end" withinPortal opened={menuOpened} onChange={setMenuOpened}>
          <Menu.Target>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={t("providerCatalog.rowActions", { name: provider.name })}
              disabled={busy}
            >
              <MoreHorizontal size={15} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<ChevronUp size={14} />}
              disabled={busy || isFirst}
              onClick={onMoveUp}
            >
              {t("providerCatalog.moveUp")}
            </Menu.Item>
            <Menu.Item
              leftSection={<ChevronDown size={14} />}
              disabled={busy || isLast}
              onClick={onMoveDown}
            >
              {t("providerCatalog.moveDown")}
            </Menu.Item>
            <Menu.Item leftSection={<Copy size={14} />} disabled={busy} onClick={onDuplicate}>
              {t("providerCatalog.duplicate")}
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item
              color="red"
              leftSection={<Trash2 size={14} />}
              disabled={busy || provider.isCurrent}
              onClick={onDelete}
            >
              {t("providerCatalog.delete")}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>

      <Tooltip
        label={provider.isCurrent
          ? t("providerCatalog.errors.currentCannotDisable")
          : t(provider.enabled ? "providerCatalog.disableProviderDescription" : "providerCatalog.enableProviderDescription")}
        withArrow
      >
        <span className="inline-flex shrink-0">
          <Switch
            size="sm"
            color="cliPrimary"
            checked={provider.enabled}
            disabled={busy || provider.isCurrent}
            aria-label={provider.enabled
              ? t("providerCatalog.disableProviderDescription")
              : t("providerCatalog.enableProviderDescription")}
            onChange={(event) => onEnabledChange(event.currentTarget.checked)}
          />
        </span>
      </Tooltip>
    </div>
  );
}
