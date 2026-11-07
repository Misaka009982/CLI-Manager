import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CircleCheck, Copy, File, Folder, GitBranch, PanelRightClose, RefreshCw, X } from "lucide-react";
import { AgentIcon } from "./AgentIcon";
import { agentName, splitPath } from "./format";
import { useGit, type GitChange } from "./git";
import { fill, type Translate } from "./i18n";
import type { JsonObject, JsonValue, WorkspaceProject, WorkspaceWorktree, Device } from "./protocol";
import type { PanelTab } from "./SessionView";

type Entry = { name: string; path: string; kind: string };
type Preview = { title: string; path: string; content: string; diff: boolean; from: PanelTab };
type Run = (kind: string, payload: JsonObject) => Promise<JsonValue>;

/** Right panel: only what the conversation does not show. Reads use the session's registered project. */
export default function Inspector({ session, project, worktree, device, status, size, grid, gitKey, run, tab, onTab, onClose, phone, t }: {
  session: { sessionId: string; title: string; projectId: string; worktreeId: string | null };
  project?: WorkspaceProject; worktree?: WorkspaceWorktree; device?: Device; status: string; size: string; grid: string;
  gitKey: string; run: Run; tab: PanelTab; onTab: (tab: PanelTab) => void; onClose: () => void; phone: boolean; t: Translate;
}) {
  const context: JsonObject = { projectId: session.projectId, ...(session.worktreeId ? { worktreeId: session.worktreeId } : {}) };
  const git = useGit(gitKey, context, run, true);
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  useEffect(() => { setPreview(undefined); }, [session.sessionId]);
  const open = async (kind: "file.read_text" | "git.diff", path: string, status?: string) => {
    const current = ++generation.current;
    setBusy(true); setFailed(false);
    try {
      const value = await run(kind, { ...context, path, ...(status ? { status } : {}) });
      if (current !== generation.current) return;
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.content !== "string") throw Error("invalid_preview");
      setPreview({ title: splitPath(path).name, path, content: value.content, diff: kind === "git.diff", from: tab });
    } catch { if (current === generation.current) setFailed(true); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const changes = git.summary?.files ?? 0;
  return <div className={`tap-inspector-body${preview ? " is-preview" : ""}`}>
    <header className="tap-inspector-head">
      {preview ? <>
        <button type="button" className="tap-back" onClick={() => setPreview(undefined)}>
          <ChevronLeft size={20} />{t(preview.from === "changes" ? "changes" : "files")}
        </button>
        <strong className="tap-inspector-title" title={preview.path}>{preview.title}</strong>
      </> : <div className="tap-tabs" role="tablist" aria-label={t("details")}>
        {(["details", "changes", "files"] as const).map((item) => <button type="button" role="tab" key={item} aria-selected={tab === item}
          onClick={() => onTab(item)}>{t(item)}{item === "changes" && changes > 0 && <span className="tap-tab-count">{changes}</span>}</button>)}
      </div>}
      <button type="button" className="tap-icon is-small" aria-label={t("refresh")} title={t("refresh")}
        onClick={() => { git.refresh(); generation.current++; setFailed(false); setReload((value) => value + 1); }}>
        <RefreshCw size={14} className={git.loading || busy ? "tap-spin" : undefined} />
      </button>
      <button type="button" className="tap-icon is-small" aria-label={t("closePanel")} title={t("closePanel")} onClick={onClose}>
        {phone ? <X size={18} /> : <PanelRightClose size={15} />}
      </button>
    </header>
    <div className="tap-inspector-scroll">
      {failed && <p className="tap-panel-error" role="alert">{t("error")}</p>}
      {preview ? <Viewer preview={preview} />
        : tab === "details" ? <Details session={session} project={project} worktree={worktree} device={device} status={status}
          size={size} grid={grid} branch={git.summary?.branch} t={t} />
        : tab === "changes" ? <Changes git={git} onOpen={(change) => void open("git.diff", change.path, change.status)} t={t} />
        : <Files key={`${session.projectId}:${session.worktreeId}:${reload}`} context={context} run={run}
          onOpen={(entry) => void open("file.read_text", entry.path)} t={t} />}
    </div>
  </div>;
}

function Row({ label, value, mono = false, copy, t }: { label: string; value: string; mono?: boolean; copy?: boolean; t: Translate }) {
  return <div className="tap-prop"><dt>{label}</dt><dd className={mono ? "is-mono" : undefined}>
    <span title={value}>{value}</span>
    {copy && <button type="button" className="tap-icon is-small" aria-label={`${t("copyValue")} ${label}`}
      onClick={() => void navigator.clipboard.writeText(value).catch(() => {})}><Copy size={13} /></button>}
  </dd></div>;
}

function Details({ session, project, worktree, device, status, size, grid, branch, t }: {
  session: { sessionId: string; title: string }; project?: WorkspaceProject; worktree?: WorkspaceWorktree; device?: Device;
  status: string; size: string; grid: string; branch?: string | null; t: Translate;
}) {
  const environment = project?.environmentType === "wsl" ? "WSL" : project?.environmentType === "ssh" ? "SSH" : t("local");
  return <div className="tap-details">
    <p className="tap-details-cli"><AgentIcon source={project?.source} size={14} />{agentName(project?.source)}</p>
    <h3>{session.title || project?.name}</h3>
    <p className="tap-details-status">{status}</p>
    <dl>
      <Row label={t("project")} value={project?.name ?? "—"} t={t} />
      {project?.cwd && <Row label={t("pathLabel")} value={project.cwd} mono copy t={t} />}
      {worktree && <Row label={t("worktree")} value={worktree.name} t={t} />}
      {(branch || worktree?.branch) && <Row label={t("branch")} value={branch || worktree?.branch || ""} mono t={t} />}
      <Row label={t("environment")} value={environment} t={t} />
      {size && <Row label={t("size")} value={`${size} · ${grid}`} t={t} />}
      {device && <Row label={t("device")} value={device.name} t={t} />}
      <Row label={t("sessionId")} value={session.sessionId} mono copy t={t} />
    </dl>
  </div>;
}

const statusClass = (status: string) => status === "A" || status === "??" ? "is-add" : status === "D" || status === "U" ? "is-del"
  : status === "R" ? "is-rename" : "is-mod";

function Changes({ git, onOpen, t }: { git: ReturnType<typeof useGit>; onOpen: (change: GitChange) => void; t: Translate }) {
  const summary = git.summary;
  if (!git.repo) return <p className="tap-panel-empty">{t("notRepo")}</p>;
  if (!summary) return git.failed ? <p className="tap-panel-error">{t("error")}</p> : <p className="tap-panel-empty">{t("loading")}</p>;
  if (!summary.changes.length) return <div className="tap-clean"><CircleCheck size={22} /><strong>{t("cleanTree")}</strong>
    {summary.branch && <code>{summary.branch}</code>}</div>;
  return <>
    {summary.branch && <p className="tap-changes-branch"><GitBranch size={13} />{summary.branch}
      {summary.ahead > 0 && <small>↑{summary.ahead}</small>}{summary.behind > 0 && <small>↓{summary.behind}</small>}</p>}
    <p className="tap-changes-summary">
      <span>{fill(t("filesChanged"), { n: summary.files })}</span>
      <span><b className="tap-add">+{summary.added}</b> <b className="tap-del">−{summary.deleted}</b></span>
      <span>{t("readOnly")}</span>
    </p>
    <div className="tap-file-list">
      {summary.changes.map((change, index) => {
        const { dir, name } = splitPath(change.path);
        return <button type="button" className="tap-file-row" key={`${change.path}:${change.staged}:${index}`} onClick={() => onOpen(change)}>
          <span className={`tap-git-letter ${statusClass(change.status)}`}>{change.status === "??" ? "U" : change.status.charAt(0)}</span>
          <span className="tap-file-name"><b>{name}</b>{dir && <small>{dir}</small>}</span>
          <span className="tap-file-delta"><b className="tap-add">+{change.added}</b><b className="tap-del">−{change.deleted}</b></span>
        </button>;
      })}
    </div>
  </>;
}

function Files({ context, run, onOpen, t }: { context: JsonObject; run: Run; onOpen: (entry: Entry) => void; t: Translate }) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setEntries(undefined); setFailed(false);
    run("file.list", { ...context, path }).then((value) => {
      if (!alive) return;
      const list = Array.isArray(value) ? value.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
      setEntries(list.filter((item) => typeof item.name === "string" && typeof item.path === "string" && item.name !== ".git")
        .map((item) => ({ name: String(item.name), path: String(item.path), kind: String(item.kind) }))
        .sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name)));
    }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [run, context.projectId, context.worktreeId, path]);
  return <>
    {path && <button type="button" className="tap-crumbs" onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}>
      <ChevronLeft size={14} /><span>{path}</span>
    </button>}
    {failed ? <p className="tap-panel-error">{t("error")}</p> : !entries ? <p className="tap-panel-empty">{t("loading")}</p>
      : !entries.length ? <p className="tap-panel-empty">{t("noFiles")}</p>
      : <div className="tap-file-list">{entries.map((entry) => <button type="button" className="tap-file-row is-tree" key={entry.path}
        onClick={() => entry.kind === "directory" ? setPath(entry.path) : onOpen(entry)}>
        {entry.kind === "directory" ? <Folder size={15} className="tap-file-icon" /> : <File size={15} className="tap-file-icon" />}
        <span className="tap-file-name"><b>{entry.name}</b></span>
        {entry.kind === "directory" && <ChevronRight size={14} className="tap-file-icon" />}
      </button>)}</div>}
  </>;
}

function Viewer({ preview }: { preview: Preview }) {
  if (!preview.diff) return <pre className="tap-viewer">{preview.content}</pre>;
  return <div className="tap-diff">{preview.content.split("\n").map((line, index) => <div key={index}
    className={line.startsWith("+++") || line.startsWith("---") ? "is-head" : line.startsWith("+") ? "is-add"
      : line.startsWith("-") ? "is-del" : line.startsWith("@@") ? "is-hunk" : undefined}>{line || "\u00a0"}</div>)}</div>;
}
