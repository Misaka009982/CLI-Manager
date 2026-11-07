import type { HistorySessionDetail, TerminalSession } from "../../../shared/types/index";
import type { TerminalTranscript, TranscriptMessage, TranscriptPart } from "../../../shared/types/webBrowser";

const clip = (text: string, limit: number) => text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
const PAGE_BYTES = 512 * 1024;
const encoder = new TextEncoder();

/** Export allowlisted canonical blocks only; detailed activity requires explicit opt-in. */
export function terminalTranscriptPage(
  session: Pick<TerminalSession, "id" | "cliSessionId">,
  detail: HistorySessionDetail | null,
  before?: number,
  includeDetails = false,
): TerminalTranscript {
  const empty = { messages: [], start: 0, total: 0 };
  if (!session.cliSessionId) return { ...empty, available: false, reason: "unbound" };
  if (!detail || detail.session_id !== session.cliSessionId)
    return { ...empty, available: false, reason: "missing" };
  const total = detail.messages.length;
  const end = Math.min(total, before ?? total);
  let start = end;
  let bytes = 1024;
  const messages: TerminalTranscript["messages"] = [];
  for (let index = end - 1; index >= Math.max(0, end - 40); index--) {
    const message = detail.messages[index]!;
    if (message.role !== "user" && message.role !== "assistant" && !(includeDetails && message.role === "tool")) {
      start = index; continue;
    }
    const source = message.parts ?? [];
    const text = source.filter((part) => message.role !== "tool" && part.kind === "text" && !part.tool_name && !part.call_id)
      .map((part) => part.content).join("\n");
    const parts: TranscriptPart[] = [];
    let remaining = 8_000, detailCount = 0, partsTruncated = false, textIndex = -1;
    source.forEach((part, index) => {
      if (message.role !== "tool" && part.kind === "text" && !part.tool_name && !part.call_id) textIndex = index;
    });
    if (includeDetails) for (let partIndex = 0; partIndex < source.length; partIndex++) {
      const part = source[partIndex]!;
      if (part.kind === "text") {
        // Reserve the ordinary reply independently: verbose tools must never hide it.
        if (partIndex === textIndex && text.trim()) parts.push({
          id: `${session.cliSessionId}:${index}:part:${partIndex}`, kind: "text", text: clip(text, 4_000), truncated: text.length > 4_000,
        });
        continue;
      }
      if (!["tool_call", "tool_result", "reasoning"].includes(part.kind)) continue;
      if (!part.content.trim()) continue;
      if (detailCount >= 23 || remaining <= 0) { partsTruncated = true; continue; }
      detailCount++;
      const visible = clip(part.content, Math.min(4_000, remaining));
      remaining -= visible.length;
      parts.push({
        id: `${session.cliSessionId}:${index}:part:${partIndex}`, kind: part.kind as TranscriptPart["kind"],
        text: visible, truncated: visible.length < part.content.length,
        ...(part.tool_name ? { toolName: clip(part.tool_name, 120) } : {}),
        // Never truncate identity into a false match with a different call.
        ...(part.call_id && part.call_id.length <= 256 ? { callId: part.call_id } : {}),
      });
    }
    if (!text.trim() && !parts.length) { start = index; continue; }
    const entry: TranscriptMessage = {
      id: `${session.cliSessionId}:${index}`, role: message.role,
      text: clip(text, 4_000), truncated: text.length > 4_000,
      at: message.timestamp && message.timestamp.length <= 64 ? message.timestamp : undefined,
      model: message.model ? clip(message.model, 256) : undefined,
      ...(includeDetails ? { parts, partsTruncated } : {}),
    };
    const size = encoder.encode(JSON.stringify(entry)).byteLength + 1;
    if (bytes + size > PAGE_BYTES) break;
    bytes += size;
    messages.unshift(entry);
    start = index;
  }
  return { available: true, cliSessionId: session.cliSessionId, start, total, messages };
}
