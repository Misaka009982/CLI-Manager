import { useMemo, useState } from "react";
import { ArrowLeft, GitBranch, History, RefreshCw, Search } from "lucide-react";
import { GitCommitGraph, layoutGitGraph } from "../../../src/features/git/api/GitCommitGraph";
import { parseGitBranches, parseGitPage, parseGitDetail, type GitCommit, type GitDetail } from "./projectGit";
import { useGitRead, type GitRepoProps } from "./projectGitRead";
import { GitDialog, GitDiffDialog, GitFileButton, GitReadFeedback } from "./GitDialogs";

export function GitHistoryWorkspace({ name, onClose, ...props }: GitRepoProps & { name: string; onClose: () => void }) {
  const { read, repository, t } = props;
  const branches = useGitRead(read, "git.branches", { repository }, parseGitBranches);
  const [reference, setReference] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const [refsOpen, setRefsOpen] = useState(false);
  return <GitDialog title={t("gitHistory")} subtitle={`${name} · ${t("gitLocalHistory")}`} kind="history" t={t} onClose={onClose}>
    <div className="web-git-toolbar">
      <button type="button" className="git-mobile-refs secondary-button" aria-expanded={refsOpen}
        onClick={() => setRefsOpen((old) => !old)}><GitBranch size={14} />{t("gitBranches")}</button>
      <span className="git-history-reference" title={reference ?? "HEAD"}><GitBranch size={14} />{reference?.replace(/^refs\/(heads|remotes)\//, "") ?? "HEAD"}</span>
      <form className="git-history-search" onSubmit={(event) => { event.preventDefault(); setSearch(input.trim()); }}>
        <input value={input} onChange={(event) => setInput(event.target.value)} maxLength={256}
          aria-label={t("gitSearch")} placeholder={t("gitSearch")} />
        <button type="submit" className="icon-button" aria-label={t("gitSearch")}><Search size={15} /></button>
      </form>
      <button type="button" className="icon-button" aria-label={t("refresh")}
        onClick={() => { branches.refresh(); setRevision((old) => old + 1); }}><RefreshCw size={15} /></button>
    </div>
    <div className="git-history-body" data-refs-open={refsOpen}>
      <nav className="git-ref-tree" aria-label={t("gitBranches")}>
        <button type="button" aria-current={reference === null ? "true" : undefined} onClick={() => { setReference(null); setRefsOpen(false); }}>
          <History size={14} />HEAD
        </button>
        <GitReadFeedback {...branches} t={t} />
        {(["local", "remote"] as const).map((type) => <section key={type}>
          <h3>{t(type === "local" ? "gitLocalBranches" : "gitRemoteBranches")}</h3>
          {branches.value?.filter((branch) => branch.branchType === type).map((branch) => {
            const ref = `refs/${type === "local" ? "heads" : "remotes"}/${branch.name}`;
            return <button type="button" key={ref} title={branch.name} aria-current={reference === ref ? "true" : undefined}
              onClick={() => { setReference(ref); setRefsOpen(false); }}>
              <GitBranch size={14} /><span>{branch.name}</span>{branch.current && <i aria-label={t("gitCurrentBranch")} />}
            </button>;
          })}
        </section>)}
      </nav>
      <CommitBrowser {...props} key={JSON.stringify([reference, search, revision])} reference={reference} search={search} />
    </div>
  </GitDialog>;
}

function CommitBrowser({ read, repository, t, reference, search }: GitRepoProps & { reference: string | null; search: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<Array<string | null>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const result = useGitRead(read, "git.history", { repository, search, cursor, reference }, parseGitPage);
  const rows = useMemo(() => layoutGitGraph(result.value?.commits ?? [], { connectOnlyVisible: Boolean(search) }), [result.value, search]);
  const selected = result.value?.commits.find((commit) => commit.id === selectedId) ?? result.value?.commits[0];
  const graphWidth = Math.min(150, Math.max(56, ...rows.map((row) => row.laneCount * 14 + 18)));
  return <div className="git-commit-browser" data-mobile-detail={mobileDetail}>
    <section className="git-log-pane" aria-label={t("gitHistory")}>
      <GitReadFeedback busy={result.busy} error={result.error} t={t} />
      {result.error && <button type="button" className="secondary-button" onClick={result.refresh}>{t("refresh")}</button>}
      {!result.busy && !result.error && !result.value?.commits.length && <p className="git-feedback">{t("gitNoCommits")}</p>}
      <div className="git-log-scroll">
        <table className="git-log-table">
          <thead><tr><th aria-label={t("gitGraph")} style={{ width: graphWidth }} /><th>{t("gitCommitMessage")}</th>
            <th className="git-log-author">{t("gitAuthor")}</th><th className="git-log-date">{t("gitDate")}</th><th>{t("gitHash")}</th></tr></thead>
          <tbody>{result.value?.commits.map((commit, index) => <tr key={commit.id} data-selected={selected?.id === commit.id}
            onClick={() => { setSelectedId(commit.id); setMobileDetail(true); }}>
            <td><GitCommitGraph row={rows[index]} width={graphWidth} /></td>
            <td><button type="button" className="git-log-message" aria-current={selected?.id === commit.id ? "true" : undefined}
              onClick={() => { setSelectedId(commit.id); setMobileDetail(true); }} title={commit.title}>
              {commit.refs.map((ref) => <span className="git-ref-badge" key={ref}>{ref}</span>)}<span>{commit.title}</span>
            </button></td>
            <td className="git-log-author" title={commit.authorEmail ?? commit.authorName}>{commit.authorName}</td>
            <td className="git-log-date"><time>{new Date(commit.authoredAt * 1000).toLocaleString(undefined, { hour12: false })}</time></td>
            <td className="git-log-hash">{commit.shortId}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <footer className="git-pagination">
        <button type="button" className="secondary-button" disabled={result.busy || !previous.length} onClick={() => {
          setCursor(previous[previous.length - 1]); setPrevious((old) => old.slice(0, -1)); setSelectedId(null);
        }}>{t("gitPreviousPage")}</button>
        <span>{previous.length + 1}</span>
        <button type="button" className="secondary-button" disabled={result.busy || !result.value?.nextCursor} onClick={() => {
          setPrevious((old) => [...old, cursor]); setCursor(result.value!.nextCursor); setSelectedId(null);
        }}>{t("gitNextPage")}</button>
      </footer>
    </section>
    <aside className="git-detail-pane" aria-label={t("gitCommitDetails")}>
      <button type="button" className="git-mobile-back secondary-button" onClick={() => setMobileDetail(false)}><ArrowLeft size={14} />{t("gitBack")}</button>
      {selected ? <CommitDetails key={selected.id} read={read} repository={repository} t={t} commit={selected} />
        : <p className="git-feedback">{t("gitSelectCommit")}</p>}
    </aside>
  </div>;
}

function CommitDetails({ read, repository, t, commit }: GitRepoProps & { commit: GitCommit }) {
  const result = useGitRead(read, "git.commit_detail", { repository, commitId: commit.id }, parseGitDetail);
  const [file, setFile] = useState<GitDetail["files"][number] | null>(null);
  const [limit, setLimit] = useState(200);
  return <>
    <div className="git-detail-heading"><h3>{commit.title}</h3><code>{commit.id}</code>
      <span>{commit.authorName}</span><time>{new Date(commit.authoredAt * 1000).toLocaleString(undefined, { hour12: false })}</time>
    </div>
    <h4 className="git-detail-files-title">{t("gitChangedFiles")} <small>{result.value?.files.length ?? ""}</small></h4>
    <GitReadFeedback {...result} t={t} />
    {result.error && <button type="button" className="secondary-button" onClick={result.refresh}>{t("refresh")}</button>}
    <ul className="git-file-list">{result.value?.files.slice(0, limit).map((entry) => <li key={entry.path}>
      <GitFileButton file={entry} onClick={() => setFile(entry)} />
    </li>)}</ul>
    {result.value && result.value.files.length > limit && <button type="button" className="secondary-button"
      onClick={() => setLimit((old) => old + 200)}>{t("filesShowMore")}</button>}
    {file && <GitDiffDialog read={read} repository={repository} t={t} file={file} commitId={commit.id} onClose={() => setFile(null)} />}
  </>;
}
