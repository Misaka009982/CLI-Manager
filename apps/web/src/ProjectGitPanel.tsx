import { useEffect, useRef, useState } from "react";
import { GitBranch, History, RefreshCw, X } from "lucide-react";
import type { Device, ProjectContext, JsonObject } from "./domain";
import { readProjectOperation } from "./projectFiles";
import { parseRepositories, parseGitStatus, type GitChange } from "./projectGit";
import { useGitRead, type GitReader, type GitRepoProps, type GitT } from "./projectGitRead";
import { GitHistoryWorkspace } from "./GitHistoryWorkspace";
import { GitDiffDialog, GitFileButton, GitReadFeedback } from "./GitDialogs";

type Props = { device?: Device; context?: ProjectContext; t: GitT; onClose: () => void };

export function ProjectGitPanel({ device, context, t, onClose }: Props) {
  const unavailable = !device || device.status !== "online" ? "gitOffline"
    : !context?.projectId ? "projectContextRequired"
      : !device.capabilities.includes("git.management") ? "capabilityUnavailable" : null;
  return <section className="project-files project-git" aria-label={t("gitChanges")}>
    <header className="project-files-heading">
      <div className="project-files-title"><strong>{context?.projectName ?? "Git"}</strong><small>{t("gitReadOnly")}</small></div>
      <button type="button" className="icon-button" onClick={onClose} aria-label={t("close")}><X size={16} /></button>
    </header>
    {unavailable ? <p role="status">{t(unavailable)}</p> : <GitBrowser device={device!} context={context!} t={t} />}
  </section>;
}

function GitBrowser({ device, context, t }: { device: Device; context: ProjectContext; t: GitT }) {
  const [read] = useState<GitReader>(() => (kind: string, parameters: JsonObject, signal: AbortSignal) =>
    readProjectOperation(device.id, context, kind, parameters, signal));
  const repos = useGitRead(read, "git.repositories", {}, parseRepositories);
  const [selected, setSelected] = useState<string | null>(null);
  const repository = repos.value?.find((item) => item.relativePath === selected)?.relativePath ?? repos.value?.[0]?.relativePath;
  return <>
    <div className="git-repository-selector">
      <GitBranch size={15} />
      <select aria-label={t("gitRepository")} value={repository ?? ""} disabled={!repos.value?.length}
        onChange={(event) => setSelected(event.target.value)}>
        {!repos.value?.length && <option value="">{t("gitRepository")}</option>}
        {repos.value?.map((item) => <option key={item.relativePath} value={item.relativePath}>
          {item.relativePath || context.projectName}{item.branch ? ` · ${item.branch}` : ""}
        </option>)}
      </select>
      <button type="button" className="icon-button" aria-label={t("refresh")} disabled={repos.busy}
        onClick={repos.refresh}><RefreshCw size={15} /></button>
    </div>
    <GitReadFeedback {...repos} t={t} />
    {repos.value?.length === 0 && <p>{t("gitNotRepository")}</p>}
    {repository !== undefined && <RepositoryView key={repository} read={read} repository={repository} t={t}
      name={repository || context.projectName} />}
  </>;
}

function RepositoryView({ name, ...props }: GitRepoProps & { name: string }) {
  const [history, setHistory] = useState(false);
  return <>
    <nav className="project-inspector-tabs" aria-label={props.t("gitReadOnly")}>
      <button type="button" aria-pressed={!history} onClick={() => setHistory(false)}>{props.t("gitChanges")}</button>
      <button type="button" aria-pressed={history} onClick={() => setHistory(true)}><History size={14} />{props.t("gitHistory")}</button>
    </nav>
    <Changes {...props} suspended={history} />
    {history && <GitHistoryWorkspace {...props} name={name} onClose={() => setHistory(false)} />}
  </>;
}

function Changes({ read, repository, t, suspended }: GitRepoProps & { suspended: boolean }) {
  const result = useGitRead(read, "git.status", { repository }, parseGitStatus);
  const [selected, setSelected] = useState<GitChange | null>(null);
  const [limit, setLimit] = useState(200);
  const refresh = useRef(result.refresh);
  refresh.current = result.refresh;
  useEffect(() => {
    if (result.busy || selected || suspended) return;
    const timer = setInterval(() => { if (!document.hidden) refresh.current(); }, 15_000);
    return () => clearInterval(timer);
  }, [result.busy, selected, suspended]);
  const groups = [
    { label: "gitStaged" as const, files: result.value?.changes.filter((item) => item.staged) ?? [] },
    { label: "gitUnstaged" as const, files: result.value?.changes.filter((item) => !item.staged && !["U", "??"].includes(item.status)) ?? [] },
    { label: "gitUntracked" as const, files: result.value?.changes.filter((item) => !item.staged && ["U", "??"].includes(item.status)) ?? [] },
  ];
  return <div className="project-files-content">
    <div className="git-summary"><span><GitBranch size={14} /> {result.value?.branch.branch ?? "HEAD"}</span>
      <button type="button" className="icon-button" aria-label={t("refresh")} disabled={result.busy} onClick={result.refresh}><RefreshCw size={15} /></button>
    </div>
    <GitReadFeedback busy={result.busy && !result.value} error={result.error} t={t} />
    {result.value && !result.value.changes.length && <p>{t("gitClean")}</p>}
    {groups.map(({ label, files }) => files.length > 0 && <section key={label} className="git-file-group">
      <h3>{t(label)} <small>{files.length}</small></h3>
      <ul className="git-file-list">{files.slice(0, limit).map((file) => <li key={file.path}>
        <GitFileButton file={file} onClick={() => setSelected(file)} />
      </li>)}</ul>
      {files.length > limit && <button type="button" className="secondary-button" onClick={() => setLimit((old) => old + 200)}>{t("filesShowMore")}</button>}
    </section>)}
    {selected && <GitDiffDialog read={read} repository={repository} t={t} file={selected} onClose={() => setSelected(null)} />}
  </div>;
}
