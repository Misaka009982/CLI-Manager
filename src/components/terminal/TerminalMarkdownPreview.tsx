import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ITheme } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../lib/i18n";
import type { HistorySessionDetail, HistorySource, Project, TerminalSession } from "../../lib/types";
import { resolveCliToolHistorySourceId } from "../../lib/cliTools";
import { isLightTerminalTheme } from "../../lib/terminalThemes";
import { resolveTerminalProjectPath } from "../../lib/terminalOscPath";
import { buildSshAgentHistoryContext, type SshAgentHistoryContext } from "../../lib/sshAgentHistory";
import { useProjectStore } from "../../stores/projectStore";
import {
  fetchLatestProjectSessionDetail,
  fetchRemoteLatestProjectSessionDetail,
} from "../../stores/historyStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { FileText, RefreshCw, X } from "../icons";
import { SessionTranscriptContent } from "../history/SessionTranscriptContent";

const PREVIEW_SOURCES = new Set<HistorySource>(["claude", "codex"]);
const LOCAL_RETRY_DELAYS_MS = [0, 180, 420];
type PreviewError = "noSession" | "loadFailed";

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function inferSourceFromText(value: string): "claude" | "codex" | null {
  const normalized = value.toLowerCase();
  if (/\bclaude\b/u.test(normalized)) return "claude";
  if (/\bcodex\b/u.test(normalized)) return "codex";
  return null;
}

function terminalThemeColor(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function buildTerminalMarkdownPreviewStyle(theme: ITheme): CSSProperties {
  const background = terminalThemeColor(theme.background, "#0c0e10");
  const foreground = terminalThemeColor(theme.foreground, "#f8fafc");
  const muted = terminalThemeColor(theme.brightBlack ?? theme.white, "#9ca0a6");
  const accent = terminalThemeColor(theme.cyan ?? theme.blue ?? theme.cursor, foreground);
  const green = terminalThemeColor(theme.green ?? theme.cyan, accent);
  const yellow = terminalThemeColor(theme.yellow, accent);
  const red = terminalThemeColor(theme.red, accent);
  const magenta = terminalThemeColor(theme.magenta, accent);
  const blue = terminalThemeColor(theme.blue, accent);

  return {
    "--terminal-theme-background": background,
    "--terminal-theme-foreground": foreground,
    "--terminal-theme-muted": muted,
    "--terminal-theme-accent": accent,
    "--terminal-theme-selection": terminalThemeColor(theme.selectionBackground, accent),
    "--term-panel-bg": background,
    "--term-panel-fg": foreground,
    "--term-panel-dim": muted,
    "--term-panel-green": green,
    "--term-panel-yellow": yellow,
    "--term-panel-red": red,
    "--term-panel-magenta": magenta,
    "--term-panel-cyan": terminalThemeColor(theme.cyan, accent),
    "--term-panel-blue": blue,
    "--term-panel-card": "color-mix(in srgb, var(--term-panel-bg) 91%, var(--term-panel-fg) 9%)",
    "--term-panel-card-inner": "color-mix(in srgb, var(--term-panel-bg) 87%, var(--term-panel-fg) 13%)",
    "--term-panel-border": "color-mix(in srgb, var(--term-panel-fg) 14%, transparent)",
    "--term-panel-track": "color-mix(in srgb, var(--term-panel-bg) 94%, var(--term-panel-fg) 6%)",
    "--ui-scrollbar-thumb": "color-mix(in srgb, var(--term-panel-fg) 28%, transparent)",
  } as CSSProperties;
}

export function resolveTerminalMarkdownSource(
  session: TerminalSession | null | undefined,
  project: Project | null | undefined,
): "claude" | "codex" | null {
  if (!session && !project) return null;
  const explicitSource = [session?.cliTool, project?.cli_tool]
    .map((value) => resolveCliToolHistorySourceId(value))
    .find((value): value is "claude" | "codex" => value === "claude" || value === "codex");
  if (explicitSource) return explicitSource;

  const inferredSource = inferSourceFromText(
    `${session?.startupCmd ?? ""} ${session?.title ?? ""} ${project?.cli_tool ?? ""}`,
  );
  return inferredSource && PREVIEW_SOURCES.has(inferredSource) ? inferredSource : null;
}

export function isTerminalMarkdownPreviewSupported(
  session: TerminalSession | null | undefined,
  project: Project | null | undefined,
): boolean {
  return resolveTerminalMarkdownSource(session, project) !== null;
}

function selectFinalAssistantContent(detail: HistorySessionDetail): string | null {
  let lastUserIndex = -1;
  for (let index = detail.messages.length - 1; index >= 0; index -= 1) {
    if (detail.messages[index]?.role.toLowerCase() === "user") {
      lastUserIndex = index;
      break;
    }
  }

  const candidates = detail.messages.slice(lastUserIndex + 1).reverse();
  const assistant = candidates.find(
    (message) => message.role.toLowerCase() === "assistant" && message.content.trim().length > 0,
  );
  return assistant?.content ?? null;
}

interface TerminalMarkdownPreviewProps {
  sessionId: string;
  open: boolean;
  onClose: () => void;
  terminalTheme: ITheme;
}

export function TerminalMarkdownPreview({ sessionId, open, onClose, terminalTheme }: TerminalMarkdownPreviewProps) {
  const { t } = useI18n();
  const terminalCodeTheme = isLightTerminalTheme(terminalTheme) ? "light" : "dark";
  const terminalPreviewStyle = useMemo(() => buildTerminalMarkdownPreviewStyle(terminalTheme), [terminalTheme]);
  const session = useTerminalStore((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const hookStatus = useTerminalStore((state) => state.tabStatuses[sessionId]?.hook ?? "none");
  const hookUpdatedAt = useTerminalStore((state) => state.tabStatuses[sessionId]?.hookUpdatedAt ?? null);
  const projects = useProjectStore((state) => state.projects);
  const worktrees = useWorktreeStore((state) => state.worktrees);
  const project = useMemo(
    () => (session?.projectId ? projects.find((item) => item.id === session.projectId) ?? null : null),
    [projects, session?.projectId],
  );
  const worktree = useMemo(
    () => (session?.worktreeId ? worktrees.find((item) => item.id === session.worktreeId) ?? null : null),
    [session?.worktreeId, worktrees],
  );
  const source = resolveTerminalMarkdownSource(session, project);
  const cliSessionId = session?.cliSessionId?.trim() || null;
  const isSshProject = project?.environment_type === "ssh" || session?.environmentType === "ssh";
  const lookupProjectPath = useMemo(() => {
    if (worktree?.path?.trim()) return worktree.path.trim();
    return resolveTerminalProjectPath(
      session?.cwd,
      isSshProject ? project?.remote_path : project?.path,
      "unknown",
    ) ?? "";
  }, [isSshProject, project?.path, project?.remote_path, session?.cwd, worktree?.path]);

  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PreviewError | null>(null);
  const remoteContextRef = useRef<SshAgentHistoryContext | null>(null);
  const requestSeqRef = useRef(0);
  const loadedTriggerRef = useRef<string | null>(null);

  const closeRemoteContext = useCallback((context: SshAgentHistoryContext | null) => {
    if (!context) return;
    void invoke("history_remote_close", {
      hostId: context.hostId,
      consumerId: context.consumerId,
    }).catch(() => undefined);
  }, []);

  useEffect(() => () => {
    closeRemoteContext(remoteContextRef.current);
    remoteContextRef.current = null;
  }, [closeRemoteContext]);

  const loadLatest = useCallback(async () => {
    const requestSeq = ++requestSeqRef.current;
    if (!source) return;
    if (!cliSessionId) {
      setError("noSession");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      let detail: HistorySessionDetail | null = null;
      for (let attempt = 0; attempt < LOCAL_RETRY_DELAYS_MS.length; attempt += 1) {
        if (LOCAL_RETRY_DELAYS_MS[attempt] > 0) await wait(LOCAL_RETRY_DELAYS_MS[attempt]);
        if (requestSeq !== requestSeqRef.current) return;

        if (isSshProject && project) {
          if (remoteContextRef.current?.launch.projectId !== project.id) {
            closeRemoteContext(remoteContextRef.current);
            remoteContextRef.current = await buildSshAgentHistoryContext(project);
          }
          const remote = await fetchRemoteLatestProjectSessionDetail(
            remoteContextRef.current,
            undefined,
            cliSessionId,
            session?.remoteTranscriptRef,
          );
          remoteContextRef.current = remote.context;
          detail = remote.result === "unchanged" ? null : remote.result;
        } else if (lookupProjectPath) {
          if (remoteContextRef.current) {
            closeRemoteContext(remoteContextRef.current);
            remoteContextRef.current = null;
          }
          const local = await fetchLatestProjectSessionDetail(
            lookupProjectPath,
            undefined,
            source,
            cliSessionId,
            { forceCatalogRefresh: true, freshDetail: true },
          );
          detail = local === "unchanged" ? null : local;
        }

        if (detail) break;
      }

      if (requestSeq !== requestSeqRef.current) return;
      if (detail) {
        setContent(selectFinalAssistantContent(detail));
        setError(null);
      } else {
        if (!content) setContent(null);
        setError("loadFailed");
      }
    } catch {
      if (requestSeq === requestSeqRef.current) setError("loadFailed");
    } finally {
      if (requestSeq === requestSeqRef.current) setLoading(false);
    }
  }, [cliSessionId, closeRemoteContext, content, isSshProject, lookupProjectPath, project, session?.remoteTranscriptRef, source]);

  useEffect(() => {
    if (!source) return;
    const completed = hookStatus === "done" || hookStatus === "failed";
    if (!open && !completed) return;
    const trigger = `${cliSessionId ?? ""}:${source}:${lookupProjectPath}:${hookStatus}:${hookUpdatedAt ?? ""}`;
    if (loadedTriggerRef.current === trigger) return;
    loadedTriggerRef.current = trigger;
    void loadLatest();
  }, [cliSessionId, hookStatus, hookUpdatedAt, loadLatest, lookupProjectPath, open, source]);

  if (!open) return null;

  return (
    <aside
      className="subagent-transcript-shell ai-replay-transcript terminal-markdown-preview flex h-full w-full min-w-0 flex-col overflow-hidden border-l text-[var(--term-panel-fg)] shadow-[-12px_0_30px_rgb(0_0_0/0.12)]"
      style={terminalPreviewStyle}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[color-mix(in_srgb,var(--border)_58%,transparent)] px-3">
        <FileText size={14} className="shrink-0 text-[var(--primary)]" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{t("terminal.markdownPreview.title")}</span>
        <button
          type="button"
          onClick={() => void loadLatest()}
          disabled={loading}
          className="ui-focus-ring inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-secondary)] transition hover:bg-[var(--interactive-hover-bg)] hover:text-[var(--text-primary)] disabled:cursor-wait disabled:opacity-50"
          aria-label={t("terminal.markdownPreview.refresh")}
          title={t("terminal.markdownPreview.refresh")}
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : undefined} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="ui-focus-ring inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-secondary)] transition hover:bg-[var(--interactive-hover-bg)] hover:text-[var(--text-primary)]"
          aria-label={t("terminal.markdownPreview.close")}
          title={t("terminal.markdownPreview.close")}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <div className="ui-scrollbar min-h-0 flex-1 overflow-auto px-4 py-3">
        {loading && !content ? (
          <div className="flex h-full items-center justify-center text-xs text-[var(--text-muted)]">
            {t("terminal.markdownPreview.loading")}
          </div>
        ) : content ? (
          <SessionTranscriptContent
            content={content}
            variant="terminal"
            terminalCodeTheme={terminalCodeTheme}
            markdownClassName="subagent-transcript-markdown"
          />
        ) : (
          <div className="flex h-full items-center justify-center px-5 text-center text-xs leading-5 text-[var(--text-muted)]">
            {error === "noSession"
              ? t("terminal.markdownPreview.noSession")
              : error === "loadFailed"
                ? t("terminal.markdownPreview.loadFailed")
                : t("terminal.markdownPreview.empty")}
          </div>
        )}
      </div>
    </aside>
  );
}
