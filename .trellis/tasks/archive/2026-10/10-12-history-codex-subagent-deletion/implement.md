# 实施与验收

1. 读取入口、分诊/历史/架构/注释契约；复核影响面，刷新 memory 索引。
2. 新增 Codex 原始 metadata 关系删除器；接入既有 IPC 和备份/回滚。
3. 更新共用资格、实际路径清理、Store 覆盖结果和批量跳过已覆盖项。
4. 使用临时 fixture 测试孤立子代理、不同日期/多层关系、fork/兄弟/其他根保留、身份歧义/越界、备份失败和 Windows 文件锁回滚；前端实际 Store action 测试含完整预检/部分失败/去重。
5. 定向测试、npx tsc --noEmit、cargo check、strict architecture、diff/索引影响面复核。
6. 同步 1.4.3 CHANGELOG、功能清单、历史契约、verification；提交本任务后利用 local 缓存构建 NSIS。
7. 核对安装包版本、时间、大小与 SHA256，保留旧安装包备份，不启动应用/安装包、不删除真实历史、不推送。

用户在诊断完成后已明确授权“修复完打包”，并批准独立修复分支/任务与版本 1.4.3。Trellis inline；项目 Trellis skills 不在当前可用列表，按真实契约和本计划主会话执行，不自动分派子代理。
