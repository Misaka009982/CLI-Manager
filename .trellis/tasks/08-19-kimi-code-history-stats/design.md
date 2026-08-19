# Design: Kimi Code local history

## Discovery list (GitNexus unavailable)

| 触点 | 处理 |
|---|---|
| `src-tauri/src/commands/history.rs` HistoryRoots / list / delete / scan dispatch | 加 `kimi_config_dir`，dispatch kimi parser |
| `src-tauri/src/commands/history/kimi.rs` | 新建：collect / parse / exact lookup / delete |
| `history/catalog.rs` HistoryRoots 字面量 | 补 `kimi_config_dir` |
| `history_edit.rs` / `request_logs.rs` | 透传 `kimi_config_dir` |
| `history_sources.rs` | 登记 `kimi`，location=configRoot，`default_leaf=.kimi-code` |
| `history_backup.rs` restore candidates | 允许 `kimi` |
| `src/lib/historySources.ts` / `historyPathArgs.ts` / `historyResumeCommand.ts` | source、pathArgs、resume |
| `cliTools.ts` / `terminalStore.ts` / `projectStartupCommand.ts` / `saveSessionToSidebar.ts` / `resumeCliArgs.ts` | resume kind 与参数剥离 |
| `TerminalStatsPanel.tsx` `inferHistorySource` | 识别 kimi |
| `i18n.ts` | `historySources.source.kimi` |
| SSH / ccusage / convert / edit | 确认无关，不扩展 |
| 未跟踪 File Preview 文件 | 不纳入本 PR |

## Layout

```
$KIMI_CODE_HOME/
  session_index.jsonl
  sessions/<workDirKey>/<sessionId>/
    state.json
    agents/main/wire.jsonl
```

列表 `file_path` 指向 main `wire.jsonl`。`project_key` 用规范化完整 cwd。

## Exact lookup

合法 id：1–128，字母数字 `_-`，无 `/` `\` `\0` `..`。不要 `Uuid::parse_str`。先读 index，再扫 `sessions/*/<id>/agents/main/wire.jsonl`。

## Delete

1. 校验 wire 路径在 kimi home 内并解析 session 目录  
2. 备份 `state.json` + main `wire.jsonl`（及 index 原文）  
3. 原子改写 `session_index.jsonl`  
4. `remove_dir_all`  
5. 目录删除失败则恢复 index  

## WSL

对 `$KIMI_CODE_HOME` UNC 使用 `wsl.exe find -name wire.jsonl`，只保留 `agents/main/wire.jsonl`。
