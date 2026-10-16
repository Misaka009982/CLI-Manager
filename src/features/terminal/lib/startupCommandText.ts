import type { ShellKey } from "../../../shared/platform/shell";

// 各 Shell 的行续接字符：行尾出现时，该行与下一行属于同一条命令。
// PowerShell/pwsh 用反引号，CMD 用 ^，Bash 家族（含 WSL/Git Bash）用反斜杠。
const SHELL_STARTUP_CONTINUATION: Partial<Record<ShellKey, string>> = {
  powershell: "`",
  pwsh: "`",
  cmd: "^",
  wsl: "\\",
  gitbash: "\\",
  bash: "\\",
  zsh: "\\",
  fish: "\\",
  sh: "\\",
};

// 未知 Shell 只把空白分隔的候选当续行符，不能猜测路径等连写内容的转义语义。
const ALL_STARTUP_CONTINUATION_CHARS = ["`", "^", "\\"];

/** 返回该 Shell 的续行符候选；未知 Shell 的候选还须经过空白分隔判定。 */
export function startupCommandContinuationChars(shell?: ShellKey | null): string[] {
  const shellChar = shell ? SHELL_STARTUP_CONTINUATION[shell] : undefined;
  return shellChar ? [shellChar] : ALL_STARTUP_CONTINUATION_CHARS;
}

// 行尾续行符与前面的内容用空白分隔时，无论它属于哪个 Shell 都按续行处理。
// 用户按自己的习惯书写续行（例如 CMD 项目里写 Bash 的反斜杠）时，若只认当前 Shell 的符号，
// 续行符就会作为命令内容送进终端：ssh 会把它当成主机名的一部分，报 hostname contains invalid characters。
function isSpacedContinuation(line: string): boolean {
  if (!ALL_STARTUP_CONTINUATION_CHARS.includes(line.slice(-1))) return false;
  return line.length === 1 || /\s/u.test(line.slice(-2, -1));
}

type CommandQuote = "'" | '"' | null;

// 仅追踪续行判定需要的引号/转义边界；不把多行命令扩展为脚本或 heredoc 解析器。
function quoteAfterLine(line: string, shell: ShellKey | null | undefined, quote: CommandQuote): CommandQuote {
  const escape = shell ? SHELL_STARTUP_CONTINUATION[shell] : undefined;
  const powershell = shell === "powershell" || shell === "pwsh";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === "'") {
      if (char === "'") {
        if (powershell && line[index + 1] === "'") index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === escape && (shell !== "cmd" || quote === null)) {
      index += 1;
    } else if (char === '"') {
      quote = quote === '"' ? null : '"';
    } else if (char === "'" && quote === null && shell !== "cmd") {
      quote = "'";
    }
  }
  return quote;
}

// 偶数个原生转义字符是完整字面转义对；奇数个才有一个未配对的续行符。
function hasTrailingContinuation(line: string, shell: ShellKey | null | undefined, quote: CommandQuote): boolean {
  if (quote === "'" || (quote === '"' && shell === "cmd")) return false;
  const tail = line.slice(-1);
  const native = shell ? SHELL_STARTUP_CONTINUATION[shell] : undefined;
  if (tail !== native) return quote === null && isSpacedContinuation(line);
  let runStart = line.length - 1;
  while (runStart > 0 && line[runStart - 1] === tail) runStart -= 1;
  return (line.length - runStart) % 2 === 1;
}

/**
 * 把多行启动命令拼接为同一条命令，识别基本引号边界及未转义的续行符。
 *
 * 单行输入原样返回（含首尾空白），保证既有单行命令零回归。多行时逐行去掉行尾续行符、
 * 丢弃空行，再用单个空格拼接：PTY 只会收到一行内容加一个回车，不会把换行当回车逐行执行，
 * 因此 `ssh` 多组 `-L` 参数这类续行命令不会被拆断。
 *
 * 原生转义符的完整转义对和受保护引号中的字面符号必须保留；跨 Shell 的单个续行标记
 * 仅在引号外且独立书写时移除。未知 Shell 不推测连写符号的语义，避免损坏路径末尾。
 */
export function joinStartupCommandLines(command: string, shell?: ShellKey | null): string {
  if (!/[\r\n]/u.test(command)) return command;
  const segments: string[] = [];
  let quote: CommandQuote = null;
  for (const rawLine of command.split(/\r\n|\r|\n/u)) {
    let line = rawLine.trim();
    if (!line) continue;
    quote = quoteAfterLine(line, shell, quote);
    if (hasTrailingContinuation(line, shell, quote)) {
      line = line.slice(0, -1).trimEnd();
    }
    if (line) segments.push(line);
  }
  return segments.join(" ");
}
