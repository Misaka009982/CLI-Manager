import { create } from "zustand";
import { logWarn } from "../../../shared/platform/logger";
import {
  deleteMessageStar,
  readMessageStars,
  writeMessageStar,
  type MessageStarInput,
  type MessageStarRow,
} from "../lib/messageStars";

interface MessageStarStore {
  /** 按历史会话键缓存的回答星标行；空数组表示“已加载且没有星标”，undefined 表示尚未加载。 */
  bySession: Record<string, MessageStarRow[] | undefined>;
  /**
   * 最近一次星标读 / 写失败的原因，成功后清空。
   * 星标失败是静默的（正文照常显示），没有这个信号用户只会看到“点了没反应”。
   */
  failure: string | null;
  /** 返回该会话可安全写入的时机；读取失败也 resolve，交给调用方按 `bySession` 判断。 */
  ensureLoaded: (sessionKey: string) => Promise<void>;
  /** 乐观写入 / 取消星标，失败回滚；取消时优先按已解析到的真实行删除。 */
  setStar: (input: MessageStarInput, star: boolean, existing?: MessageStarRow | null) => Promise<void>;
}

// 同一会话并发加载只发一次请求，避免多个预览面板同时打开时重复读表。
const inFlightLoads = new Map<string, Promise<void>>();

function sortRows(rows: MessageStarRow[]): MessageStarRow[] {
  return [...rows].sort((a, b) => a.message_index - b.message_index);
}

export const useMessageStarStore = create<MessageStarStore>((set, get) => ({
  bySession: {},
  failure: null,

  ensureLoaded: (sessionKey) => {
    if (!sessionKey) return Promise.resolve();
    if (get().bySession[sessionKey] !== undefined) return Promise.resolve();
    const running = inFlightLoads.get(sessionKey);
    if (running) return running;
    const task = readMessageStars(sessionKey)
      .then((rows) => {
        // 读成功后清掉上一次的失败：数据库恢复（例如重启后补上迁移）时提示要能自己消失。
        set((state) => ({ bySession: { ...state.bySession, [sessionKey]: sortRows(rows) }, failure: null }));
      })
      .catch((err) => {
        // 保留 undefined 让后续刷新可以重试；星标读取失败不影响预览正文，只上报失败态。
        logWarn("history.messageStars.loadFailed", { sessionKey, error: String(err) });
        set({ failure: String(err) });
      })
      .finally(() => {
        inFlightLoads.delete(sessionKey);
      });
    inFlightLoads.set(sessionKey, task);
    return task;
  },

  setStar: async (input, star, existing) => {
    const { sessionKey } = input;
    // 必须等加载落地再改内存：读取结果整体替换该会话的行，会把读取期间产生的乐观写入一起冲掉。
    await get().ensureLoaded(sessionKey);
    const previous = get().bySession[sessionKey];
    const current = previous ?? [];
    const existingIndex = existing?.message_index ?? input.messageIndex;
    const optimistic: MessageStarRow[] = star
      ? [...current.filter((row) => row.message_index !== input.messageIndex), {
        session_key: sessionKey,
        message_index: input.messageIndex,
        timestamp: input.timestamp,
        source: input.source,
        session_id: input.sessionId,
        created_at: Date.now(),
      }]
      : current.filter((row) => row.message_index !== existingIndex);
    set((state) => ({ bySession: { ...state.bySession, [sessionKey]: sortRows(optimistic) } }));

    try {
      if (star) await writeMessageStar(input);
      else await deleteMessageStar(sessionKey, existingIndex);
      set({ failure: null });
    } catch (err) {
      logWarn("history.messageStars.writeFailed", { sessionKey, messageIndex: input.messageIndex, error: String(err) });
      const previousForSession = previous ?? [];
      set((state) => ({
        bySession: { ...state.bySession, [sessionKey]: previousForSession },
        failure: String(err),
      }));
    }
  },
}));
