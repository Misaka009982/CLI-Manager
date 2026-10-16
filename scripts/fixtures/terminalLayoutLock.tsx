import { createRoot } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { SortableTab, SortableWorkspanTab } from "../../src/features/terminal/components/SortableTerminalTabs";
import { TerminalLayoutLockIndicator, TerminalLayoutLockMenu } from "../../src/features/terminal/api/TerminalLayoutLockControls";
import { ContextMenuItem } from "../../src/shared/ui/context-menu";
import { useSettingsStore } from "./terminalLayoutLockStore";
import { Toaster } from "sonner";
import { getTerminalTheme } from "../../src/shared/lib/terminalThemes";
import "../../src/styles/components/terminal-empty-tabs.css";
import "../../src/styles/components/focus-controls.css";
import "../../src/styles/components/terminal-actions-panes.css";

const params = new URLSearchParams(location.search);
const tone = params.get("terminal") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = params.get("app") ?? "light";
useSettingsStore.setState({ language: params.get("language") ?? "zh-CN", resolvedTheme: tone });
const theme = getTerminalTheme("auto", tone);
const noOp = () => {};
const menu = () => <>
  <ContextMenuItem>Close</ContextMenuItem>
  <ContextMenuItem>Rename</ContextMenuItem>
  <ContextMenuItem>Split</ContextMenuItem>
</>;

function Harness() {
  return <>
    <style>{`
      :root { --surface-container-lowest: white; --on-surface-variant: #475569;
        --on-surface: #111; --border: #aaa; --interactive-hover-bg: #ddd; }
      .bar { display:flex; align-items:center; width:700px; height:48px; margin:20px; }
      .bar .ui-tab-trigger { display:flex; align-items:center; width:170px; padding:8px; }
      .space { flex:1; height:100%; }
      .ui-terminal-well { --terminal-theme-background: ${theme.background};
        --terminal-theme-foreground: ${theme.foreground};
        --terminal-theme-muted: #64748b; --terminal-tab-accent: #729bea;
        --terminal-tab-accent-muted:#5f7caf; --terminal-tab-border:#748094;
        background: var(--terminal-theme-background); padding:10px; }
    `}</style>
    <Toaster />
    <button id="toggle-lock" onClick={() => useSettingsStore.setState(s => ({ terminalLayoutLocked: !s.terminalLayoutLocked }))}>Toggle</button>
    <DndContext>
      <SortableContext items={["pane-tab", "workspan:workspan-tab"]}>
        <div className="ui-terminal-well" data-terminal-theme-tone={tone}>
          <TerminalLayoutLockMenu>
            <div className="bar ui-terminal-pane-chrome" id="pane-bar">
              <SortableTab id="pane-tab" paneId="pane" title="Pane tab" isActive isEditing={false}
                notification="none" hoverInfo={{}} onActivate={noOp} onClose={noOp}
                onSubmitEdit={noOp} onCancelEdit={noOp} menuContent={menu} />
              <div className="space" />
              <TerminalLayoutLockIndicator />
              <button className="ui-terminal-tab-list-button" data-reference-button>Reference</button>
            </div>
          </TerminalLayoutLockMenu>
          <TerminalLayoutLockMenu>
            <div className="bar ui-terminal-pane-chrome" id="workspan-bar">
              <SortableWorkspanTab workspan={{ id: "workspan-tab", customTitle: null, paneTree: null, activePaneId: null, activeSessionId: null }}
                title="Workspan tab" notification="none" isActive dragDisabled={false} renameDisabled={false}
                onActivate={noOp} onClose={noOp} onRename={noOp} menuStyle={{}} menuContent={menu} />
              <div className="space" />
              <TerminalLayoutLockIndicator />
            </div>
          </TerminalLayoutLockMenu>
        </div>
      </SortableContext>
    </DndContext>
  </>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
