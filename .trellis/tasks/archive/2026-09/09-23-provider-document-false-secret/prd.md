# 修复供应商原始文档普通配置字段误判密钥

## Goal

修复供应商原始文档将普通配置误判成密钥并拒绝保存的问题，保留对真实凭据的安全保护。

## Requirements

- Codex/Grok TOML 原始文档中的普通字段（至少 `model_auto_compact_token_limit`）可以保存、回显，不会被替换为 `[REDACTED]`。
- 真正的密钥字段仍遮罩已有值，禁止在原始文档编辑器新增或修改凭据；保留 Claude JSON 与嵌套结构的安全行为。
- 不更改通用配置的格式校验规则，也不读取或输出用户真实配置/密钥。

## Acceptance Criteria

- [ ] 普通配置不会触发“含密钥”提示，新增和修改后重新读取保持原值。
- [ ] 真实 `api_key` / `ANTHROPIC_AUTH_TOKEN` 继续脱敏，编辑普通字段时保留旧密钥，文档内新增/修改密钥仍被拒绝。
- [ ] 补充定向回归测试并运行相关 Rust 检查，如实报告未覆盖项。

## Notes

- 根因位于后端供应商文档敏感字段分类及保存校验，不在前端提示文案。
- 当前分支 `fix/web-file-tree-operation-latency` 无上游；不自行执行 Git 同步。
