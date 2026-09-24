import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { logError } from "../../../shared/platform/logger";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import { normalizeExternalTerminalProgram } from "../../../shared/lib/externalTerminalProgram";
import { normalizeShellKey } from "../../../shared/platform/shell";
import { translateCurrent } from "../../../shared/i18n/index";

export interface ExternalTab {
  cwd?: string;
  title: string;
  startupCmd?: string;
  shell?: string;
}

// 可执行路径保留原值；内置名称别名统一为后端键，避免把 powershell.exe 当作未知 Shell。
function externalShell(shell?: string | null) {
  const value = shell?.trim();
  if (!value) return null;
  return /[\\/]/.test(value) ? value : normalizeShellKey(value) ?? value;
}

export async function openWindowsTerminal(tabs: ExternalTab[]) {
  if (!tabs.length) return;
  const settings = useSettingsStore.getState();
  const program = normalizeExternalTerminalProgram(settings.externalTerminalProgram);
  try {
    await invoke("open_windows_terminal", {
      program,
      tabs: tabs.map((t) => ({
        cwd: t.cwd ?? null,
        title: t.title,
        startup_cmd: t.startupCmd ?? null,
        shell: externalShell(t.shell) ?? (program === "windows-terminal" ? externalShell(settings.defaultShell) : null),
      })),
    });
  } catch (err) {
    const message = String(err);
    const isTerminalNotFound = /not_found|program notfound|not found|no supported terminal/i.test(message);
    toast.error(translateCurrent("settings.terminal.externalOpenFailed"), {
      description: isTerminalNotFound
        ? translateCurrent("settings.terminal.externalProgramMissing")
        : message,
    });
    logError("Failed to open external terminal", err);
  }
}
