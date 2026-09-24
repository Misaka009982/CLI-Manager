import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createGitModuleLoader } from "./helpers/loadGitModule.mjs";

// 星标写入必须落到真实行，解析与读写回滚是本次功能唯一的非 UI 契约，因此直接加载真实模块。
function loader(overrides = {}) {
  return createGitModuleLoader({
    [resolve("src/features/history/lib/messageStars.ts")]: {
      readMessageStars: async () => [],
      writeMessageStar: async () => {},
      deleteMessageStar: async () => {},
    },
    [resolve("src/shared/platform/logger.ts")]: { logWarn: () => {}, logInfo: () => {}, logError: () => {} },
    ...overrides,
  });
}

const row = (messageIndex, timestamp) => ({
  session_key: "local:a:project",
  message_index: messageIndex,
  timestamp,
  source: "claude",
  session_id: "a",
  created_at: 1,
});

const input = messageIndex => ({
  sessionKey: "key", messageIndex, timestamp: null, source: "claude", sessionId: "a",
});

test("starred rows resolve back to the current answer list and follow rewound indexes", () => {
  const { resolveStarredMessageIndexes } = loader()(resolve("src/features/terminal/lib/markdownPreviewStars.ts"));
  const messages = [
    { messageIndex: 2, timestamp: "2026-09-16T05:00:00.000Z" },
    { messageIndex: 4, timestamp: "2026-09-16T05:10:00.000Z" },
  ];

  // 下标与时间戳都对得上：直接命中，不做时间戳兜底。
  assert.deepEqual([...resolveStarredMessageIndexes(messages, [row(4, "2026-09-16T05:10:00.000Z")]).keys()], [4]);
  // 对话被回退重写后下标整体平移：按时间戳把星标跟到回答的新位置。
  assert.deepEqual([...resolveStarredMessageIndexes(messages, [row(9, "2026-09-16T05:10:00.000Z")]).keys()], [4]);
  // 下标还在但换了回答（下标复用）：不能沿用旧下标，按时间戳重新定位。
  assert.deepEqual([...resolveStarredMessageIndexes(messages, [row(4, "2026-09-16T05:00:00.000Z")]).keys()], [2]);
});

test("unresolvable and duplicate stars never mispoint at another answer", () => {
  const { resolveStarredMessageIndexes } = loader()(resolve("src/features/terminal/lib/markdownPreviewStars.ts"));
  const messages = [{ messageIndex: 4, timestamp: "2026-09-16T05:10:00.000Z" }];

  // 回答已被删掉：星标失效但行保留，等回答回来仍能重新生效。
  assert.equal(resolveStarredMessageIndexes(messages, [row(4, "2026-09-16T04:00:00.000Z")]).size, 0);
  assert.equal(resolveStarredMessageIndexes(messages, [row(9, null)]).size, 0);
  assert.equal(resolveStarredMessageIndexes(messages, undefined).size, 0);
  assert.equal(resolveStarredMessageIndexes(messages, []).size, 0);
  // 同一回答有多余行（时间戳兜底后与直接命中重叠）：只认一个，避免重复标记。
  const resolved = resolveStarredMessageIndexes(messages, [row(4, "2026-09-16T05:10:00.000Z"), row(9, "2026-09-16T05:10:00.000Z")]);
  assert.deepEqual([...resolved.keys()], [4]);
});

test("star loading is cached per session and a failed read stays retryable", async () => {
  const reads = [];
  let failNext = true;
  const load = loader({
    [resolve("src/features/history/lib/messageStars.ts")]: {
      readMessageStars: async sessionKey => {
        reads.push(sessionKey);
        if (failNext) throw new Error("db locked");
        return [row(7, null)];
      },
      writeMessageStar: async () => {},
      deleteMessageStar: async () => {},
    },
  });
  const { useMessageStarStore } = load(resolve("src/features/history/store/messageStarStore.ts"));

  useMessageStarStore.getState().ensureLoaded("key");
  useMessageStarStore.getState().ensureLoaded("key");
  await settle();
  assert.deepEqual(reads, ["key"], "concurrent opens of the same session only read once");
  // 读取失败不能把会话标成“已加载且没有星标”，否则刷新一次就再也拉不到。
  assert.equal(useMessageStarStore.getState().bySession.key, undefined);

  failNext = false;
  useMessageStarStore.getState().ensureLoaded("key");
  await settle();
  assert.deepEqual(reads, ["key", "key"]);
  assert.deepEqual(useMessageStarStore.getState().bySession.key.map(item => item.message_index), [7]);

  useMessageStarStore.getState().ensureLoaded("key");
  await settle();
  assert.deepEqual(reads, ["key", "key"], "a loaded session is not read again");
});

test("toggling a star writes optimistically and rolls back when the write fails", async () => {
  const writes = [], deletes = [];
  let failWrite = false;
  const load = loader({
    [resolve("src/features/history/lib/messageStars.ts")]: {
      readMessageStars: async () => [row(4, "2026-09-16T05:10:00.000Z")],
      writeMessageStar: async input => { writes.push(input); if (failWrite) throw new Error("disk full"); },
      deleteMessageStar: async (sessionKey, messageIndex) => { deletes.push([sessionKey, messageIndex]); },
    },
  });
  const { useMessageStarStore } = load(resolve("src/features/history/store/messageStarStore.ts"));
  const store = () => useMessageStarStore.getState();

  store().ensureLoaded("key");
  await settle();
  assert.deepEqual(store().bySession.key.map(item => item.message_index), [4]);

  // 取消时星标可能因回退已跟随到新下标：必须删除真实行，而不是当前展示位置。
  await store().setStar(input(9), false, row(12, "2026-09-16T05:10:00.000Z"));
  assert.deepEqual(deletes, [["key", 12]]);
  assert.deepEqual(store().bySession.key.map(item => item.message_index), [4]);

  await store().setStar(input(9), true, null);
  assert.deepEqual(writes.map(item => item.messageIndex), [9]);
  assert.deepEqual(store().bySession.key.map(item => item.message_index), [4, 9], "stars stay ordered by answer index");

  failWrite = true;
  await store().setStar(input(11), true, null);
  assert.deepEqual(store().bySession.key.map(item => item.message_index), [4, 9], "a failed write restores the previous rows");
});

test("a slow load cannot clobber a star added while it is still in flight", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const writes = [];
  const load = loader({
    [resolve("src/features/history/lib/messageStars.ts")]: {
      readMessageStars: async () => { await gate; return []; },
      writeMessageStar: async input => { writes.push(input.messageIndex); },
      deleteMessageStar: async () => {},
    },
  });
  const { useMessageStarStore } = load(resolve("src/features/history/store/messageStarStore.ts"));
  const store = () => useMessageStarStore.getState();

  store().ensureLoaded("key");
  const write = store().setStar(input(9), true, null);
  await settle();
  // 读取还没落地时内存里不该出现乐观行：否则读取结果整体替换会把这条写入冲掉，星标看起来“闪一下消失”。
  assert.equal(store().bySession.key, undefined);
  release();
  await write;
  assert.deepEqual(writes, [9]);
  assert.deepEqual(store().bySession.key.map(item => item.message_index), [9],
    "the loaded rows must not overwrite the star written while the read was in flight");
});

test("storage failures surface a signal the UI can show, and clear on success", async () => {
  let failRead = true, failWrite = false;
  const load = loader({
    [resolve("src/features/history/lib/messageStars.ts")]: {
      readMessageStars: async () => {
        if (failRead) throw new Error("no such table: message_stars");
        return [];
      },
      writeMessageStar: async () => {
        if (failWrite) throw new Error("no such table: message_stars");
      },
      deleteMessageStar: async () => {},
    },
  });
  const { useMessageStarStore } = load(resolve("src/features/history/store/messageStarStore.ts"));
  const store = () => useMessageStarStore.getState();

  store().ensureLoaded("key");
  await settle();
  // 缺表只在日志里报的话，用户看到的是“点了没反应”，失败必须能被界面读到。
  assert.match(store().failure, /no such table/);

  failRead = false;
  store().ensureLoaded("key");
  await settle();
  assert.equal(store().failure, null, "a successful read clears the stale failure");

  failWrite = true;
  await store().setStar(input(4), true, null);
  assert.match(store().failure, /no such table/);
  assert.deepEqual(store().bySession.key, [], "a failed write leaves no phantom star in memory");

  failWrite = false;
  await store().setStar(input(4), true, null);
  assert.equal(store().failure, null, "a successful write clears the failure banner");
  assert.deepEqual(store().bySession.key.map(item => item.message_index), [4]);
});

function settle() {
  return new Promise(resolve => setImmediate(resolve));
}
