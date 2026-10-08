import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Columns2, FileCode2, Rows3, X } from "lucide-react";
import { GitSnapshotDiff } from "../../../src/features/git/api/GitSnapshotDiff";
import type { TranslationKey } from "./i18n";
import { parseGitDiff, type GitChange } from "./projectGit";
import { useGitRead, type GitRepoProps, type GitT } from "./projectGitRead";
import "react-diff-view/style/index.css";

export function GitDialog({ title, subtitle, onClose, children, t, kind }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode; t: GitT; kind: "history" | "diff";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<dialog className={`web-git-dialog web-git-${kind}`} ref={ref} aria-labelledby={titleId}
    onKeyDown={(event) => event.stopPropagation()}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className="web-git-dialog-header">
      <div><strong id={titleId}>{title}</strong>{subtitle && <small title={subtitle}>{subtitle}</small>}</div>
      <button type="button" className="icon-button" autoFocus onClick={onClose} aria-label={t("close")}><X size={18} /></button>
    </header>
    {children}
  </dialog>, document.body);
}

export function GitReadFeedback({ busy, error, t }: { busy: boolean; error: TranslationKey | null; t: GitT }) {
  return <>{busy && <p className="git-feedback" role="status">{t("filesLoading")}</p>}
    {error && <p className="git-feedback" role="alert">{t(error)}</p>}</>;
}

export function GitFileButton({ file, onClick }: { file: GitChange; onClick: () => void }) {
  const slash = file.path.lastIndexOf("/");
  return <button type="button" onClick={onClick} title={file.path}>
    <FileCode2 size={15} className="git-file-icon" />
    <span className="git-file-path"><span>{file.path.slice(slash + 1)}</span>
      {slash >= 0 && <small>{file.path.slice(0, slash)}</small>}</span>
    <span className="git-file-status" data-status={file.status}>{file.status}</span>
    <small><span className="git-added">+{file.added}</span> <span className="git-deleted">−{file.deleted}</span></small>
  </button>;
}

export function GitDiffDialog({ read, repository, t, file, commitId, onClose }: GitRepoProps & {
  file: GitChange & { oldPath?: string | null; binary?: boolean }; commitId?: string; onClose: () => void;
}) {
  return <GitDialog title={file.path.split("/").pop() ?? file.path}
    subtitle={file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}
    t={t} kind="diff" onClose={onClose}>
    {file.binary ? <p className="git-feedback">{t("gitDiffUnavailable")}</p>
      : <DiffContent read={read} repository={repository} t={t} file={file} commitId={commitId} />}
  </GitDialog>;
}

function DiffContent({ read, repository, t, file, commitId }: GitRepoProps & {
  file: GitChange & { oldPath?: string | null }; commitId?: string;
}) {
  const [mode, setMode] = useState<"split" | "unified">(() => matchMedia("(max-width: 767px)").matches ? "unified" : "split");
  const result = useGitRead(read, commitId ? "git.commit_diff" : "git.diff", {
    repository, path: file.path, status: file.status,
    ...(commitId ? { commitId, oldPath: file.oldPath ?? null } : {}),
  }, parseGitDiff);
  return <>
    <div className="web-git-toolbar">
      <span className="git-diff-source">{commitId ? commitId.slice(0, 8) : t("gitWorkingTree")}</span>
      <div className="git-view-modes" aria-label={t("gitDiffLayout")}>
        <button type="button" aria-pressed={mode === "split"} onClick={() => setMode("split")}><Columns2 size={14} />{t("gitSplit")}</button>
        <button type="button" aria-pressed={mode === "unified"} onClick={() => setMode("unified")}><Rows3 size={14} />{t("gitUnified")}</button>
      </div>
    </div>
    <GitReadFeedback {...result} t={t} />
    {result.error && <button type="button" className="secondary-button" onClick={result.refresh}>{t("refresh")}</button>}
    {result.value !== null && <>
      {mode === "split" && <div className="git-diff-sides"><span>{t("gitBefore")}</span><span>{t("gitAfter")}</span></div>}
      <GitSnapshotDiff content={result.value} viewMode={mode} labels={{ loading: t("filesLoading"), empty: t("gitNoDiff"),
        unavailable: t("gitDiffUnavailable"), raw: t("gitRawFallback") }} />
    </>}
  </>;
}
