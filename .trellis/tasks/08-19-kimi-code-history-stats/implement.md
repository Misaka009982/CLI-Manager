# Implement

1. `HistoryRoots` + IPC `kimiConfigDir` 贯穿 list/get/search/delete/stats/index。
2. `history/kimi.rs` parser/collect/lookup/delete + 接到 `scan_session_*`。
3. 前端 source/resume/stats infer/i18n。
4. Rust fixture 与 Node resume/pathArgs 测试。
5. CHANGELOG TEMP、功能清单、history-index / history-session / cli-hook 契约。
6. `cargo test` 聚焦 history、`npx tsc --noEmit`、fmt、diff check。
7. review 子代理后修复，再开 PR。
