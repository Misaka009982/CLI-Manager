# 实施与交付
1. 保留已验证内存优化基线，独立 fix/terminal-ui-memory 分支。
2. 预览仅在 open && isVisible 读取，关闭释放答案并拒绝迟到结果，选择索引保留。
3. 快照单飞/强制补轮、来源取消信号和身份校验、保存失败标脏重试；不改行数。
4. 既有 runtimeDiagnostics 接入计数，不新增配置或无调用模块。
5. 定向测试、tsc、strict architecture、diff 检查及记录，先提交后 NSIS，用户验收前不归档。
