import type { TerminalSession } from "../../../shared/types/index";
import { extractCodexProfileName } from "../../history/api/resumeCliArgs";
import { useTerminalStore } from "../state";

/** Only a local PTY can describe a profile in this machine's Codex Home. */
export function codexHookProfileForSession(session: TerminalSession | undefined): string | null {
  if (!session || (session.kind && session.kind !== "pty") || session.sshHostId
    || session.remoteHandoff || session.environmentType === "ssh" || session.environmentType === "wsl"
    || session.wslDistroName || /(?:^|[/\\])(wsl(?:\.exe)?|bash|zsh|fish)(?:\b|$)/i.test(session.shell ?? "")) return null;
  if (session.startupCmd) return extractCodexProfileName(session.startupCmd);
  return session.cliTool === "codex" ? session.providerSnapshot?.codexProfileName ?? null : null;
}

export function useActiveCodexHookProfile(): string | null {
  return useTerminalStore((state) => codexHookProfileForSession(
    state.sessions.find((session) => session.id === state.activeSessionId),
  ));
}
