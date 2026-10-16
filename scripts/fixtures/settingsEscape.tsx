import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsModal } from "../../src/features/settings/api/SettingsModal";
import { useSettingsStore, type LanguagePreference } from "./settingsEscapeStore";
import "../../src/styles/components/focus-controls.css";

declare global {
  interface Window {
    escapeTest: { language: (language: LanguagePreference) => void };
  }
}

function Harness() {
  const [open, setOpen] = useState(false);
  window.escapeTest = { language: language => useSettingsStore.setState({ language }) };
  return <>
    <style>{`
      :root { --primary: #1769ee; --interactive-focus-ring: #87b2ff; }
      #main-content { height: 700px; background: #101010; color: white; }
      .ui-workspace-settings-overlay { position: fixed; inset: 26px 0 0; }
      .ui-workspace-settings-dialog { height: 100%; background: white; }
      .ui-settings-layout { display: flex; height: 100%; }
      .ui-settings-content { flex: 1; }
    `}</style>
    <main id="main-content" tabIndex={-1}>
      <button id="open-settings" onClick={() => setOpen(true)}>Settings</button>
      <button id="keyboard-button">Terminal action</button>
    </main>
    <SettingsModal open={open} onClose={() => setOpen(false)} initialTab="cc-connect" />
  </>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
