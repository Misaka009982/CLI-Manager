import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, LoaderCircle, RefreshCw, Search, X } from "lucide-react";
import { getMaterialFileIcon, getMaterialFolderIcon } from "@baybreezy/file-extension-icon";
import type { Device, ProjectContext } from "./domain";
import type { TranslationKey } from "./i18n";
import { parseFileEntries, parseFilePreview, readProjectFiles, type FileEntry, type FileReadKind } from "./projectFiles";
import { createProjectDirectorySession } from "./projectDirectorySession";
import { directoryScope } from "./projectDirectoryCache";
import "./projectFiles.css";

type Props = { device?: Device; context?: ProjectContext; t: (key: TranslationKey) => string; onClose?: () => void };

export const ProjectFilesPanel = memo(function ProjectFilesPanel({ device, context, t, onClose }: Props) {
  const unavailable = !device || device.status !== "online" ? "filesOffline"
    : !context?.projectId ? "projectContextRequired"
      : !device.capabilities.includes("file.management") ? "capabilityUnavailable" : null;
  return <section className="project-files" aria-label={t("projectFiles")}>
    {unavailable ? <><FileHeading context={context} t={t} onClose={onClose} /><p role="status">{t(unavailable)}</p></> :
      <FileBrowser key={directoryScope(device!.id, context!)}
        device={device!} context={context!} t={t} onClose={onClose} />}
  </section>;
});

function FileHeading({ context, t, onClose, children }: Pick<Props, "context" | "t" | "onClose"> & { children?: React.ReactNode }) {
  return <header className="project-files-heading">
    <div className="project-files-title" title={[context?.cwd, context?.branch, t("filesReadOnly")].filter(Boolean).join("\n")}>
      <strong>{context?.projectName ?? t("projectFiles")}</strong>
      {context?.branch && <small>{context.branch}</small>}
    </div>
    <div className="project-files-actions">{children}
      {onClose && <button className="icon-button" type="button" title={t("close")} aria-label={t("close")} onClick={onClose}><X size={16} /></button>}
    </div>
  </header>;
}

function fileError(error: unknown, kind: FileReadKind): TranslationKey {
  const code = error instanceof Error ? error.message : "";
  if (code === "session_expired") return "sessionExpired";
  if (/ssh_project_unsupported/.test(code)) return "filesSshUnsupported";
  if (/file_result_too_large/.test(code) && (kind === "file.list" || kind === "file.search")) return "filesListTooLarge";
  if (/too_large|binary|unsupported|invalid_file_result/.test(code)) return "filesPreviewUnavailable";
  if (/project_not_found|worktree_missing|worktree_not_found/.test(code)) return "filesContextMissing";
  return "filesReadFailed";
}

function FileBrowser({ device, context, t, onClose }: Required<Pick<Props, "device" | "context" | "t">> & Pick<Props, "onClose">) {
  const [directorySession] = useState(() => createProjectDirectorySession(device.id, context));
  const { directories, pending, loading, errors } = useSyncExternalStore(directorySession.subscribe, directorySession.getSnapshot);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [results, setResults] = useState<FileEntry[] | null>(null);
  const [preview, setPreview] = useState<{ path: string; image: boolean; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const request = useRef<AbortController | null>(null);
  const requestKind = useRef<FileReadKind | null>(null);

  const run = async (kind: Exclude<FileReadKind, "file.list">, path: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    requestKind.current = kind;
    setBusy(true);
    setError(null);
    try {
      const value = await readProjectFiles(device.id, context, kind, path, controller.signal);
      if (controller.signal.aborted) return;
      if (kind === "file.search") setResults(parseFileEntries(value));
      else setPreview({ path, image: kind === "file.read_image", content: parseFilePreview(value, kind === "file.read_image") });
    } catch (reason) {
      if (!controller.signal.aborted) setError(fileError(reason, kind));
    } finally {
      if (request.current === controller) {
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  };

  useEffect(() => {
    directorySession.load("");
    return () => {
      request.current?.abort();
      directorySession.stop();
    };
    // Identity changes remount this component; do not restart reads on workspace snapshots.
  }, [directorySession]);

  const select = (entry: FileEntry) => {
    setSelectedPath(entry.path);
    if (entry.kind === "directory") {
      request.current?.abort(); setBusy(false); setPreview(null); setError(null);
      if (expanded.has(entry.path)) setExpanded((old) => { const next = new Set(old); next.delete(entry.path); return next; });
      else {
        setExpanded((old) => new Set([...old, entry.path]));
        directorySession.load(entry.path);
      }
    } else {
      setPreview(null);
      void run(/\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(entry.path) ? "file.read_image" : "file.read_text", entry.path);
    }
  };
  const renderEntries = (entries: FileEntry[], path = "", ancestors = new Set<string>()): React.ReactNode => <ul className="project-files-tree">
    {entries.slice(0, visibleCount[path] ?? 200).map((entry) => {
      const folder = entry.kind === "directory";
      const open = expanded.has(entry.path) && !ancestors.has(entry.path);
      const children = directories.get(entry.path);
      return <li key={entry.path}>
        <button type="button" data-selected={selectedPath === entry.path} aria-busy={folder && pending.has(entry.path)}
          onPointerEnter={() => { if (folder) directorySession.prefetch(entry.path); }}
          onFocus={() => { if (folder) directorySession.prefetch(entry.path); }}
          onPointerLeave={directorySession.cancelPrefetch} onBlur={directorySession.cancelPrefetch}
          title={entry.path} aria-expanded={folder ? open : undefined} onClick={() => select(entry)}>
          {folder && loading.has(entry.path) ? <LoaderCircle size={14} className="project-files-spinner" /> :
            folder ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span className="file-indent" />}
          <img src={folder ? getMaterialFolderIcon(entry.name, open) : getMaterialFileIcon(entry.name)} width={16} height={16} alt="" draggable={false} />
          <span>{entry.name}</span>
        </button>
        {folder && open && errors.has(entry.path) && <div role="alert" className="file-directory-error">
          <small>{t(fileError(errors.get(entry.path), "file.list"))}</small>
          <button type="button" onClick={() => directorySession.load(entry.path)}><RefreshCw size={14} />{t("refresh")}</button>
        </div>}
        {folder && open && children && (children.length
          ? renderEntries(children, entry.path, new Set([...ancestors, entry.path])) : <small className="file-empty">{t("filesEmpty")}</small>)}
      </li>;
    })}
    {entries.length > (visibleCount[path] ?? 200) && <li><button className="project-files-more" type="button"
      onClick={() => setVisibleCount((old) => ({ ...old, [path]: (old[path] ?? 200) + 200 }))}>
      {t("filesShowMore")} ({entries.length - (visibleCount[path] ?? 200)})
    </button></li>}
  </ul>;

  return <>
    <FileHeading context={context} t={t} onClose={onClose}>
      <button className="icon-button" type="button" aria-expanded={searchOpen} title={t("filesSearch")} aria-label={t("filesSearch")}
        onClick={() => {
          setSearchOpen(!searchOpen);
          if (searchOpen) {
            if (requestKind.current === "file.search") { request.current?.abort(); setBusy(false); }
            setQuery(""); setResults(null); setError(null);
          }
        }}><Search size={16} /></button>
      <button className="icon-button" type="button" title={t("refresh")} aria-label={t("refresh")} onClick={() => {
        request.current?.abort(); setBusy(false); setError(null);
        setQuery(""); setResults(null); setPreview(null); setSelectedPath(null);
        setExpanded(new Set()); setVisibleCount({}); directorySession.refresh();
      }}><RefreshCw size={16} /></button>
    </FileHeading>
    {searchOpen && <form className="project-files-search" onSubmit={(event) => {
      event.preventDefault();
      if (busy) return;
      setPreview(null); setResults(null);
      if (query.trim()) void run("file.search", query.trim());
    }}>
      <input autoFocus disabled={busy} aria-label={t("filesSearch")} placeholder={t("filesSearch")} maxLength={512} value={query}
        onChange={(event) => { setQuery(event.target.value); if (!event.target.value) setResults(null); }} />
      <button className="icon-button" type="submit" disabled={busy || !query.trim()} aria-label={t("filesSearch")}><Search size={17} /></button>
    </form>}
    {(busy || (loading.has("") && !directories.has(""))) && <p role="status">{t("filesLoading")}</p>}
    {error && <p role="alert">{t(error)}</p>}
    {errors.has("") && <p role="alert">{t(fileError(errors.get(""), "file.list"))}</p>}
    <div className="project-files-content" aria-busy={busy || pending.size > 0}>
      {preview ? <div className="project-files-preview">
        <button className="secondary-button" type="button" onClick={() => setPreview(null)}><ArrowLeft size={16} />{t("filesBack")}</button>
        <small className="file-preview-path">{preview.path}</small>
        {preview.image ? <img src={preview.content} alt={preview.path} /> : <pre tabIndex={0}>{preview.content}</pre>}
      </div> : (results ?? directories.get(""))?.length ? renderEntries(results ?? directories.get("") ?? [], results ? "search" : "") :
        !busy && !pending.has("") && !error && !errors.has("") && <p>{t("filesEmpty")}</p>}
    </div>
  </>;
}
