import { getDb } from "../../../shared/platform/db";
import type { HistorySource } from "../../../shared/types/index";

/** 回答星标行：以 (session_key, message_index) 唯一标识一条历史回答。 */
export interface MessageStarRow {
  session_key: string;
  message_index: number;
  timestamp: string | null;
  source: string;
  session_id: string;
  created_at: number;
}

export interface MessageStarInput {
  sessionKey: string;
  messageIndex: number;
  timestamp: string | null;
  source: HistorySource;
  sessionId: string;
}

// SQLite 的 INTEGER 可能以 bigint 返回；星标只做边界校验，不做时间换算。
function normalizeMessageStarRow(row: unknown): MessageStarRow | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  const sessionKey = typeof record.session_key === "string" ? record.session_key : "";
  const messageIndex = Number(record.message_index);
  if (!sessionKey || !Number.isInteger(messageIndex) || messageIndex < 0) return null;
  return {
    session_key: sessionKey,
    message_index: messageIndex,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : null,
    source: typeof record.source === "string" ? record.source : "",
    session_id: typeof record.session_id === "string" ? record.session_id : "",
    created_at: Number(record.created_at) || 0,
  };
}

/** 读取单个历史会话的全部回答星标；读取失败由调用方决定降级策略（见 messageStarStore）。 */
export async function readMessageStars(sessionKey: string): Promise<MessageStarRow[]> {
  if (!sessionKey.trim()) return [];
  const db = await getDb();
  const rows = await db.select<unknown[]>(
    `SELECT session_key, message_index, timestamp, source, session_id, created_at
       FROM message_stars WHERE session_key = $1 ORDER BY message_index ASC`,
    [sessionKey],
  );
  return rows.map(normalizeMessageStarRow).filter((row): row is MessageStarRow => row !== null);
}

/**
 * 写入回答星标。同一回答（会话键 + 回答序号）重复标记只刷新时间戳等元数据；
 * 若该序号此前的星标指向另一条回答（对话被回退后序号被复用），则整体覆盖为新回答。
 */
export async function writeMessageStar(input: MessageStarInput): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO message_stars
      (session_key, message_index, timestamp, source, session_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(session_key, message_index) DO UPDATE SET
      timestamp = excluded.timestamp,
      source = excluded.source,
      session_id = excluded.session_id`,
    [
      input.sessionKey,
      input.messageIndex,
      input.timestamp,
      input.source,
      input.sessionId,
      Date.now(),
    ],
  );
}

export async function deleteMessageStar(sessionKey: string, messageIndex: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM message_stars WHERE session_key = $1 AND message_index = $2",
    [sessionKey, messageIndex],
  );
}
