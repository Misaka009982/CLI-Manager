import { Folder, GitBranch, RefreshCw } from "lucide-react";
import { count } from "./format";
import type { GitState } from "./git";
import type { Translate } from "./i18n";

/**
 * One status row under the composer, grouped to the left. Only facts the host reports appear;
 * there is no model, usage or limit data in CLI-Manager, so those chips are simply absent.
 */
export function DockStatus({ linkOk, size, project, git, phone, onReconnect, onFiles, onChanges, t }: {
  linkOk: boolean; size?: string; project: string; git: GitState; phone: boolean;
  onReconnect: () => void; onFiles: () => void; onChanges: () => void; t: Translate;
}) {
  const summary = git.summary;
  const changed = summary && (summary.added > 0 || summary.deleted > 0);
  return <div className="tap-dock-status">
    {!linkOk && <span className="tap-dock-lost"><i aria-hidden />{t("linkLost")}
      <button type="button" className="tap-text-button" onClick={onReconnect}><RefreshCw size={12} />{t("reconnect")}</button>
    </span>}
    {size && <span className="tap-dock-size">{size}</span>}
    {(!phone || !summary?.branch) && <button type="button" className="tap-dock-chip" title={project} onClick={onFiles}>
      <Folder size={13} /><span>{project}</span>
    </button>}
    {summary?.branch && <button type="button" className="tap-dock-chip is-branch" title={summary.branch} onClick={onChanges}>
      <GitBranch size={13} /><span>{summary.branch}</span>
      {summary.ahead > 0 && <small>↑{summary.ahead}</small>}{summary.behind > 0 && <small>↓{summary.behind}</small>}
    </button>}
    {phone && changed && <button type="button" className="tap-dock-chip is-changes" aria-label={t("changes")} onClick={onChanges}>
      <span className="tap-add">+{count(summary.added)}</span><span className="tap-del">−{count(summary.deleted)}</span>
    </button>}
  </div>;
}
