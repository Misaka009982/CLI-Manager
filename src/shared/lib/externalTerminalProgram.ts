export const EXTERNAL_TERMINAL_PROGRAMS = ["windows-terminal", "cmd", "powershell", "pwsh"] as const;
export type ExternalTerminalProgram = typeof EXTERNAL_TERMINAL_PROGRAMS[number];

// 旧配置与损坏值保持 Windows Terminal 默认；不把任意字符串当作可执行路径。
export function normalizeExternalTerminalProgram(value: unknown): ExternalTerminalProgram {
  return EXTERNAL_TERMINAL_PROGRAMS.find((program) => program === value) ?? "windows-terminal";
}
