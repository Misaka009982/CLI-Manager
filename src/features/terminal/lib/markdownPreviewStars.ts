import type { MessageStarRow } from "../../history/index";

/** 解析星标所需的回答最小信息：源消息下标与时间戳。 */
export interface StarResolvableMessage {
  messageIndex: number;
  timestamp: string | null;
}

/**
 * 把表里存下的星标行映射回当前回答列表。
 *
 * 存的是源消息下标，而对话文件在 `/rewind`、压缩或重写后会整体平移，因此下标不能直接信任：
 * 先按下标 + 时间戳双重校验，失配时再按时间戳把星标跟到回答的新位置；回答已不存在时该星标
 * 视为失效（不显示、不误指到别的回答），行本身保留，等回答回来仍能重新生效。
 */
export function resolveStarredMessageIndexes(
  messages: readonly StarResolvableMessage[],
  rows: readonly MessageStarRow[] | undefined,
): Map<number, MessageStarRow> {
  const resolved = new Map<number, MessageStarRow>();
  if (!rows || rows.length === 0) return resolved;

  const byIndex = new Map<number, StarResolvableMessage>();
  const byTimestamp = new Map<string, number>();
  for (const message of messages) {
    byIndex.set(message.messageIndex, message);
    if (message.timestamp && !byTimestamp.has(message.timestamp)) {
      byTimestamp.set(message.timestamp, message.messageIndex);
    }
  }

  for (const row of rows) {
    const direct = byIndex.get(row.message_index);
    let target: number | null = null;
    if (direct && (!row.timestamp || direct.timestamp === row.timestamp)) {
      target = row.message_index;
    } else if (row.timestamp) {
      target = byTimestamp.get(row.timestamp) ?? null;
    }
    if (target === null || resolved.has(target)) continue;
    resolved.set(target, row);
  }
  return resolved;
}
