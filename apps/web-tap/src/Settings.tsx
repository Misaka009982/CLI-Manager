import { ArrowUpRight, ChevronRight, Folder, GitBranch, LogOut, Minus, Monitor, Moon, Plus, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { AgentIcon } from "./AgentIcon";
import { useSheetClose } from "./Sheet";
import { CHAT_SIZES, resolved, TERMINAL_SIZES, type Preferences } from "./preferences";
import type { Translate } from "./i18n";
import type { WorkspaceModel } from "./useWorkspace";
import type { WorkspaceProject } from "./protocol";
import { buildProjectTree, type ProjectTreeNode } from "./projectTree";

function Stepper({ value, range, label, onChange, t }: {
  value: number; range: { min: number; max: number }; label: string; onChange: (value: number) => void; t: Translate;
}) {
  return <span className="tap-stepper" role="group" aria-label={label}>
    <button type="button" className="tap-icon is-small" aria-label={t("smaller")} disabled={value <= range.min} onClick={() => onChange(value - 1)}>
      <Minus size={15} />
    </button>
    <output>{value}</output>
    <button type="button" className="tap-icon is-small" aria-label={t("larger")} disabled={value >= range.max} onClick={() => onChange(value + 1)}>
      <Plus size={15} />
    </button>
  </span>;
}

/** Display preferences stay on this browser; no native select menus. */
export function Settings({ prefs, setPrefs, onLogout, t }: {
  prefs: Preferences; setPrefs: (prefs: Preferences) => void; onLogout: () => void; t: Translate;
}) {
  const values = resolved(prefs);
  const themes = [["light", Sun], ["dark", Moon], ["system", Monitor]] as const;
  return <div className="tap-settings">
    <section>
      <h3>{t("theme")}</h3>
      <div className="tap-theme-tiles" role="radiogroup" aria-label={t("theme")}>
        {themes.map(([theme, Icon]) => <button type="button" role="radio" aria-checked={prefs.theme === theme} key={theme}
          onClick={() => setPrefs({ ...prefs, theme })}><Icon size={17} />{t(theme)}</button>)}
      </div>
    </section>
    <section>
      <h3>{t("display")}</h3>
      <div className="tap-card">
        <div className="tap-card-row"><span>{t("language")}</span>
          <span className="tap-segmented" role="radiogroup" aria-label={t("language")}>
            {(["zh-CN", "en-US"] as const).map((language) => <button type="button" role="radio" key={language}
              aria-checked={prefs.language === language} onClick={() => setPrefs({ ...prefs, language })}>
              {language === "zh-CN" ? "简体中文" : "English"}
            </button>)}
          </span>
        </div>
        <div className="tap-card-row"><span>{t("chatSize")}</span>
          <Stepper value={values.chatSize} range={CHAT_SIZES} label={t("chatSize")} t={t} onChange={(chatSize) => setPrefs({ ...prefs, chatSize })} />
        </div>
        <div className="tap-card-row"><span>{t("fontSize")}</span>
          <Stepper value={values.fontSize} range={TERMINAL_SIZES} label={t("fontSize")} t={t} onChange={(fontSize) => setPrefs({ ...prefs, fontSize })} />
        </div>
        <label className="tap-card-row"><span>{t("showKeys")}<small>{t("showKeysHint")}</small></span>
          <input type="checkbox" role="switch" className="tap-switch" checked={values.keys}
            onChange={(event) => setPrefs({ ...prefs, keys: event.target.checked })} />
        </label>
      </div>
    </section>
    <section>
      <h3>{t("account")}</h3>
      <div className="tap-card">
        <a className="tap-card-row is-link" href="/"><span>{t("classic")}</span><ArrowUpRight size={15} /></a>
        <button type="button" className="tap-card-row is-danger" onClick={onLogout}><span>{t("logout")}</span><LogOut size={15} /></button>
      </div>
    </section>
  </div>;
}

/** Native project start: the host resolves path and CLI command from the registered project. */
export function NewSession({ model, onStart, t }: {
  model: WorkspaceModel; onStart: (project: WorkspaceProject, worktreeId?: string) => void; t: Translate;
}) {
  const online = model.device?.status === "online";
  const close = useSheetClose();
  const start = (project: WorkspaceProject, worktreeId?: string) => { onStart(project, worktreeId); close(); };
  const tree = buildProjectTree(model.workspace);
  // The picker and sidebar share desktop group identity/order, including projects without sessions.
  const renderNodes = (nodes: ProjectTreeNode[]): ReactNode => nodes.map((node) => {
    if (node.kind === "group") return <section className="tap-picker-group" key={node.key}>
      <h3><Folder size={14} />{node.group.name}</h3>
      <div className="tap-picker-children">{node.children.length
        ? renderNodes(node.children) : <p className="tap-panel-empty">{t("emptyGroup")}</p>}</div>
    </section>;
    const { project } = node;
    const unsupported = project.environmentType === "ssh";
    return <div className="tap-card" key={node.key}>
      <button type="button" className="tap-project-row" disabled={model.starting || unsupported || !online} onClick={() => start(project)}>
        <span className="tap-project-icon"><AgentIcon source={project.source} size={18} /></span>
        <span className="tap-project-text"><b>{project.name}</b>
          <small className={unsupported ? undefined : "is-mono"}>{unsupported ? t("unsupportedProject") : project.cwd}</small></span>
        <ChevronRight size={16} className="tap-row-chevron" />
      </button>
      {model.workspace.worktrees.filter((worktree) => worktree.projectId === project.id).map((worktree) => <button type="button"
        className="tap-project-row is-worktree" key={worktree.id} disabled={model.starting || unsupported || !online || worktree.status === "missing"}
        onClick={() => start(project, worktree.id)}>
        <span className="tap-project-icon"><GitBranch size={15} /></span>
        <span className="tap-project-text"><b>{worktree.name}</b><small className="is-mono">{worktree.branch}</small></span>
        <ChevronRight size={16} className="tap-row-chevron" />
      </button>)}
    </div>;
  });
  return <div className="tap-new-session">
    <p className="tap-sheet-lead">{t("source")}</p>
    {!tree.length && <p className="tap-panel-empty">{t("noProjects")}</p>}
    {renderNodes(tree)}
  </div>;
}
