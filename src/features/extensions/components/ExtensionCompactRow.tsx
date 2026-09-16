import type { ReactNode } from "react";

interface ExtensionCompactRowProps {
  leading?: ReactNode;
  name: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  selected?: boolean;
  compact?: boolean;
  className?: string;
}

/** MCP、Skill 与项目策略共用的资源行；详情跨满整行，避免把操作区挤出窄窗口。 */
export function ExtensionCompactRow({
  leading,
  name,
  description,
  meta,
  status,
  actions,
  children,
  selected = false,
  compact = false,
  className = "",
}: ExtensionCompactRowProps) {
  return (
    <div
      data-selected={selected ? "true" : "false"}
      className={`flex min-w-0 flex-wrap items-center transition-colors ${compact
        ? `gap-x-2 rounded-md border border-transparent px-2 py-1.5 ${selected ? "bg-surface-container-low" : "hover:bg-surface-container-low/60"}`
        : `gap-x-4 gap-y-2 rounded-xl border px-3 py-2.5 ${selected
          ? "border-primary/70 bg-primary/10"
          : "border-border/70 bg-surface-container-low hover:border-border"}`
      } ${className}`}
    >
      <div className="flex min-w-0 flex-[1_1_18rem] items-center gap-2">
        {leading && <div className="shrink-0">{leading}</div>}
        <div className="min-w-0 flex-1">
          <div className={`min-w-0 text-text-primary ${compact ? "text-[13px] font-medium leading-5" : "text-sm font-semibold"}`}>{name}</div>
          {description && <div className="mt-0.5 min-w-0 text-xs text-text-muted">{description}</div>}
          {meta && <div className="mt-1 min-w-0">{meta}</div>}
        </div>
      </div>
      {(status || actions) && (
        <div className="ml-auto flex min-w-0 flex-[0_1_auto] flex-wrap items-center justify-end gap-2">
          {status}
          {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </div>
      )}
      {children && <div className="basis-full min-w-0 border-t border-border/50 pt-2">{children}</div>}
    </div>
  );
}
