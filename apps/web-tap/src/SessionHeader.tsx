import { useEffect, useState } from "react";
import {
  ALargeSmall, Ellipsis, FileDiff, Folder, Minus, MessagesSquare, PanelLeft, PanelRight, Plus, Power, Settings, SquarePen,
  SquareTerminal,
} from "lucide-react";
import { Menu } from "./Menu";
import { TERMINAL_SIZES, type ViewMode } from "./preferences";
import { count } from "./format";
import type { Translate } from "./i18n";
import type { GitSummary } from "./git";

export type SessionStatus = "running" | "connecting" | "ended" | "offline";
const statusText = { running: "statusRunning", connecting: "statusConnecting", ended: "statusEnded", offline: "statusOffline" } as const;

/** Session title row: what is running where, the view switch and the session's own actions. */
export function SessionHeader({ sessionId, active, title, project, agent, status, linkOk, view, size, phone, panelOpen, git,
  fontSize, onFontSize, onView, onDrawer, onPanel, onNewSession, onSettings, onEnd, t }: {
  sessionId: string; active: boolean; title: string; project: string; agent: string; status: SessionStatus; linkOk: boolean; view: ViewMode; size: string;
  phone: boolean; panelOpen: boolean; git: GitSummary | null; fontSize: number;
  onFontSize: (size: number) => void; onView: (view: ViewMode) => void; onDrawer: () => void; onPanel: () => void;
  onNewSession: () => void; onSettings: () => void; onEnd: () => void; t: Translate;
}) {
  const [menu, setMenu] = useState<"closed" | "open" | "confirm">("closed");
  const close = () => setMenu("closed");
  // A confirmation belongs to this session only; switching away dismisses it instead of retargeting it.
  useEffect(() => { if (!active) setMenu("closed"); }, [active]);
  const changed = git && (git.added || git.deleted);
  return <header className="tap-topbar">
    {phone && <button type="button" className="tap-icon" aria-label={t("openSessions")} onClick={onDrawer}><PanelLeft size={18} /></button>}
    <div className="tap-title">
      <h1><i className={`tap-status is-${status}`} aria-hidden /><span>{title}</span></h1>
      {phone ? <p className="tap-subtitle">
        <i className={`tap-link${linkOk ? "" : " is-lost"}`} title={t(linkOk ? "linkOnline" : "linkLost")} />
        <span>{project} · {agent}{view === "terminal" && size ? ` · ${size}` : ""}</span>
      </p> : <p className="tap-subtitle">
        <i className={`tap-link${linkOk ? "" : " is-lost"}`} />{t(statusText[status])}
      </p>}
    </div>
    <div className="tap-top-actions">
      {!phone && <span className="tap-crumb" title={project}><Folder size={13} /><span>{project}</span><b>/</b><span>{agent}</span></span>}
      <div className="tap-toggle" role="tablist" aria-label={t("view")}>
        <button type="button" role="tab" id={`chat-tab-${sessionId}`} aria-controls={`chat-${sessionId}`}
          aria-selected={view === "chat"} aria-label={t("chat")} title={t("chat")} onClick={() => onView("chat")}>
          <MessagesSquare size={16} /><span>{t("chat")}</span>
        </button>
        <button type="button" role="tab" id={`terminal-tab-${sessionId}`} aria-controls={`terminal-${sessionId}`}
          aria-selected={view === "terminal"} aria-label={t("terminal")} title={t("terminal")}
          onClick={() => onView("terminal")}>
          <SquareTerminal size={16} /><span>{t("terminal")}</span>
        </button>
      </div>
      {phone ? <button type="button" className="tap-icon" aria-label={t("openPanel")} onClick={onPanel}><PanelRight size={18} /></button>
        : <button type="button" className={`tap-changes-chip${panelOpen ? " is-open" : ""}`} aria-pressed={panelOpen}
          aria-label={panelOpen ? t("closePanel") : t("openPanel")} title={panelOpen ? t("closePanel") : t("openPanel")} onClick={onPanel}>
          {changed ? <><span className="tap-add">+{count(git.added)}</span><span className="tap-del">−{count(git.deleted)}</span></>
            : <FileDiff size={16} />}
        </button>}
      <span className="tap-menu-anchor">
        <button type="button" className="tap-icon" aria-label={t("more")} aria-haspopup="menu" aria-expanded={menu !== "closed"}
          onClick={() => setMenu(menu === "closed" ? "open" : "closed")}><Ellipsis size={18} /></button>
        <Menu open={menu === "open"} onClose={close} label={t("more")} placement="down-end">
          {phone && <button type="button" role="menuitem" onClick={() => { close(); onNewSession(); }}>
            <SquarePen size={16} /><span>{t("newSession")}</span>
          </button>}
          <div className="tap-menu-stepper" role="group" aria-label={t("fontSize")}>
            <ALargeSmall size={16} /><span>{t("fontSize")}</span>
            <button type="button" aria-label={t("smaller")} disabled={fontSize <= TERMINAL_SIZES.min} onClick={() => onFontSize(fontSize - 1)}>
              <Minus size={15} />
            </button>
            <output>{fontSize}</output>
            <button type="button" aria-label={t("larger")} disabled={fontSize >= TERMINAL_SIZES.max} onClick={() => onFontSize(fontSize + 1)}>
              <Plus size={15} />
            </button>
          </div>
          <button type="button" role="menuitem" onClick={() => { close(); onSettings(); }}><Settings size={16} /><span>{t("settings")}</span></button>
          {status !== "ended" && <button type="button" role="menuitem" className="is-danger" onClick={() => setMenu("confirm")}>
            <Power size={16} /><span>{t("endSession")}</span>
          </button>}
        </Menu>
        <Menu open={menu === "confirm"} onClose={close} label={t("endTitle")} placement="down-end" className="is-confirm" role="alertdialog">
          <strong>{t("endTitle")}</strong>
          <p>{t("endBody")}</p>
          <div className="tap-confirm-actions">
            <button type="button" className="tap-text-button" data-autofocus onClick={close}>{t("cancel")}</button>
            <button type="button" className="tap-quiet-danger" onClick={() => { close(); onEnd(); }}>
              <Power size={15} />{t("endConfirm")}
            </button>
          </div>
        </Menu>
      </span>
    </div>
  </header>;
}
