import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, PanelLeft, Plus, SquareTerminal, X } from "lucide-react";
import { useWorkspace } from "./useWorkspace";
import { usePreferences } from "./preferences";
import { fill, translator } from "./i18n";
import { useViewportBox, startViewport } from "./viewport";
import { Sidebar } from "./Sidebar";
import { Sheet } from "./Sheet";
import { Drawer, useEdgeSwipe } from "./Drawer";
import { NewSession, Settings } from "./Settings";
import { clearGit, gitKey } from "./git";
import type { PanelTab } from "./SessionView";
import type { TerminalInfo } from "./Terminal";

const Inspector = lazy(() => import("./Inspector"));
const SessionView = lazy(() => import("./SessionView").then((module) => ({ default: module.SessionView })));
const DOCK_WIDTH = 272 + 320 + 560;

/** Compose the optional client; classic view components and state are never imported. */
export function App() {
  const model = useWorkspace();
  const { prefs, setPrefs, phone } = usePreferences();
  const t = translator(prefs.language);
  const [sheet, setSheet] = useState<"projects" | "settings" | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [lastTab, setLastTab] = useState<PanelTab>("details");
  const [docked, setDocked] = useState(() => innerWidth >= DOCK_WIDTH);
  // The phone panel keeps its content through the closing slide, then drops it so hidden tabs stop reading.
  const [panelMounted, setPanelMounted] = useState(false);
  const [infos, setInfos] = useState<Record<string, TerminalInfo>>({});
  const accountScope = JSON.stringify([model.user?.id, model.deviceId]);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [pairingError, setPairingError] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useViewportBox(root);
  useEdgeSwipe(root, phone && Boolean(model.user));
  useEffect(() => { startViewport(); }, []);
  useEffect(() => { setSheet(null); setDrawer(false); setPanel(null); }, [accountScope]);
  useEffect(() => { if (!model.user) clearGit(); }, [model.user]);
  useEffect(() => {
    if (panel) { setPanelMounted(true); return; }
    const timer = setTimeout(() => setPanelMounted(false), 360);
    return () => clearTimeout(timer);
  }, [panel]);
  useEffect(() => {
    const resize = () => setDocked(innerWidth >= DOCK_WIDTH);
    addEventListener("resize", resize);
    return () => removeEventListener("resize", resize);
  }, []);
  const session = model.workspace.terminals?.find((item) => item.sessionId === model.activeId);
  const project = model.workspace.projects.find((item) => item.id === session?.projectId);
  const openPanel = (tab?: PanelTab) => {
    // The desktop chip toggles; dock chips and the phone button always open (on the requested tab).
    if (!phone && !tab && panel) { setPanel(null); return; }
    if (!phone && tab === "changes" && panel === "changes") { setPanel(null); return; }
    const next = tab ?? lastTab;
    setLastTab(next); setPanel(next);
  };
  const language = <button type="button" className="tap-text-button" onClick={() => setPrefs({ ...prefs, language: prefs.language === "zh-CN" ? "en-US" : "zh-CN" })}>
    {prefs.language === "zh-CN" ? "English" : "简体中文"}
  </button>;

  if (model.mobileToken) return <div ref={root} className="tap-login"><div className="tap-login-card">
    <span className="tap-login-mark"><SquareTerminal size={22} /></span>
    <h1>{t("authorize")}</h1><p>{t("authorizeHint")}</p>
    {model.authError && <p className="tap-login-error" role="alert">{t("loginError")}</p>}
    <div className="tap-login-actions">
      <button type="button" className="tap-button" disabled={model.checking} onClick={model.cancelMobile}>{t("cancel")}</button>
      <button type="button" className="tap-button is-primary" disabled={model.checking} onClick={() => void model.redeemMobile()}>{t("confirm")}</button>
    </div>
  </div></div>;

  if (!model.user) return <div ref={root} className="tap-login">
    <div className="tap-login-card">
      <span className="tap-login-mark"><SquareTerminal size={22} /></span>
      <h1>{t("app")}</h1><p>{t("loginHint")}</p>
      <form onSubmit={(event) => { event.preventDefault(); void model.login(username, password).then(() => setPassword("")); }}>
        <label>{t("username")}<input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label>
        <label>{t("password")}<input type="password" autoComplete="current-password" required value={password}
          onChange={(event) => setPassword(event.target.value)} /></label>
        {model.authError && <p className="tap-login-error" role="alert">{t(model.authError === "authExpired" ? "authExpired" : "loginError")}</p>}
        <button className="tap-button is-primary is-wide" disabled={model.checking}>
          {t(model.checking ? "statusConnecting" : "login")}{!model.checking && <ArrowRight size={17} />}
        </button>
      </form>
      <div className="tap-login-links"><a href="/">{t("classic")}<ArrowUpRight size={13} /></a>{language}</div>
    </div>
  </div>;

  const sidebar = <Sidebar model={model} t={t} phone={phone} onPick={() => { setDrawer(false); setSheet("projects"); }}
    onSettings={() => { setDrawer(false); setSheet("settings"); }} onClose={phone ? () => setDrawer(false) : undefined} />;
  const info = session ? infos[session.sessionId] : undefined;
  const state = session ? model.states[session.sessionId] : undefined;
  const inspector = session && <Suspense fallback={null}>
    <Inspector key={accountScope} session={session} project={project} device={model.device}
      worktree={model.workspace.worktrees.find((item) => item.id === session.worktreeId)}
      status={t(["exited", "closed"].includes(state?.status ?? "") ? "statusEnded" : "statusRunning")}
      size={info?.size ?? ""} grid={t(state?.controlMode === "web" ? "browserSize" : "desktopSize")}
      gitKey={gitKey(model.user.id, model.deviceId, session.projectId, session.worktreeId)} run={model.run}
      tab={panel ?? lastTab} onTab={(tab) => { setLastTab(tab); setPanel(tab); }} onClose={() => setPanel(null)} phone={phone} t={t} />
  </Suspense>;
  const count = model.workspace.terminals?.length ?? 0;
  return <div ref={root} className={`tap-app${!phone && panel && session ? (docked ? " has-panel" : " has-float") : ""}`}>
    {!phone && sidebar}
    <main className="tap-workspace">
      {model.error && <div className="tap-toast" role="alert">
        <span>{t(model.error === "unknownDelivery" ? "unknownDelivery" : model.error === "sendFailed" ? "sendFailed" : "error")}</span>
        <button type="button" className="tap-text-button" onClick={() => { model.setError(""); model.refresh(); }}>{t("retry")}</button>
        <button type="button" className="tap-icon is-small" aria-label={t("close")} onClick={() => model.setError("")}><X size={14} /></button>
      </div>}
      {model.device?.status === "offline" && <div className="tap-offline" role="status">{t("deviceOffline")}</div>}
      {!model.devices.length ? <div className="tap-empty">
        {phone && <EmptyBar title={t("workspace")} onDrawer={() => setDrawer(true)} t={t} />}
        <div className="tap-empty-body">
          <span className="tap-empty-tile"><SquareTerminal size={28} /></span><h2>{t("noDevices")}</h2><p>{t("pairHint")}</p>
          <form className="tap-pair" onSubmit={(event) => { event.preventDefault(); setPairingError(false); void model.pair(pairingCode).catch(() => setPairingError(true)); }}>
            <input required aria-label={t("code")} placeholder={t("code")} value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} />
            <button className="tap-button is-primary">{t("pair")}</button>
          </form>{pairingError && <p className="tap-login-error" role="alert">{t("error")}</p>}
        </div>
      </div> : !model.activeId ? <div className="tap-empty">
        {phone && <EmptyBar title={t("workspace")} subtitle={fill(t("sessionCount"), { n: count })} onDrawer={() => setDrawer(true)} t={t} />}
        <div className="tap-empty-body">
          <span className="tap-empty-tile"><SquareTerminal size={28} /></span>
          <h2>{t(count ? "pickSession" : "startSession")}</h2><p>{t(count ? "pickHint" : "startHint")}</p>
          <div className="tap-empty-actions">
            <button type="button" className="tap-button is-primary" onClick={() => setSheet("projects")}
              disabled={!model.workspace.projects.length || model.device?.status !== "online"}><Plus size={16} />{t("newSession")}</button>
            {phone && count > 0 && <button type="button" className="tap-button" onClick={() => setDrawer(true)}>{t("viewSessions")}</button>}
          </div>
        </div>
      </div> : <div className="tap-sessions" key={accountScope}>
        <Suspense fallback={<p className="tap-chat-empty" role="status">{t("loading")}</p>}>
          {[...model.mounted].sort().map((id) => <SessionView key={id} id={id} active={model.activeId === id} model={model}
            prefs={prefs} setPrefs={setPrefs} phone={phone} panelOpen={Boolean(panel)} onDrawer={() => setDrawer(true)}
            onPanel={openPanel} onNewSession={() => setSheet("projects")} onSettings={() => setSheet("settings")}
            onInfo={(sessionId, next) => setInfos((old) => old[sessionId]?.size === next.size && old[sessionId]?.direct === next.direct
              ? old : { ...old, [sessionId]: next })} t={t} />)}
        </Suspense>
      </div>}
    </main>
    {!phone && panel && session && <>
      {!docked && <div className="tap-panel-scrim" onClick={() => setPanel(null)} aria-hidden />}
      <aside className="tap-inspector" aria-label={t("details")}>{inspector}</aside>
    </>}
    {phone && <Drawer side="left" open={drawer} label={t("sessions")} onOpen={() => setDrawer(true)} onClose={() => setDrawer(false)}>
      {sidebar}
    </Drawer>}
    {phone && session && <Drawer side="right" open={Boolean(panel)} label={t("details")} className="tap-inspector is-sheet"
      onOpen={() => openPanel(lastTab)} onClose={() => setPanel(null)}>{panelMounted && inspector}</Drawer>}
    {sheet === "projects" && <Sheet title={t("newSession")} onClose={() => setSheet(null)} t={t}>
      <NewSession model={model} t={t} onStart={(item, worktreeId) => { void model.start(item, worktreeId); }} />
    </Sheet>}
    {sheet === "settings" && <Sheet title={t("settings")} onClose={() => setSheet(null)} t={t}>
      <Settings prefs={prefs} setPrefs={setPrefs} t={t} onLogout={() => { setSheet(null); void model.logout(); }} />
    </Sheet>}
  </div>;
}

function EmptyBar({ title, subtitle, onDrawer, t }: { title: string; subtitle?: string; onDrawer: () => void; t: (key: "openSessions") => string }) {
  return <header className="tap-topbar">
    <button type="button" className="tap-icon" aria-label={t("openSessions")} onClick={onDrawer}><PanelLeft size={18} /></button>
    <div className="tap-title"><h1><span>{title}</span></h1>{subtitle && <p className="tap-subtitle"><span>{subtitle}</span></p>}</div>
  </header>;
}
