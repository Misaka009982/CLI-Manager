import { TerminalSquare } from "lucide-react";
import { CliToolIcon } from "../../../src/shared/ui/CliToolIcon";
import type { WorkspaceProject } from "./protocol";

type Source = WorkspaceProject["source"] | undefined;

/** The project's configured CLI; unknown sources fall back to a neutral terminal glyph. */
export function AgentIcon({ source, size = 16 }: { source: Source; size?: number }) {
  // Brand SVGs carry their own <title>; keep them out of row names such as "Claude 修复登录页".
  return <span className="tap-agent-glyph" aria-hidden>
    {source === "claude" ? <CliToolIcon icon="claude-code" size={size} className="" />
      : source === "codex" ? <CliToolIcon icon="codex" size={size} className="" /> : <TerminalSquare size={size} />}
  </span>;
}
