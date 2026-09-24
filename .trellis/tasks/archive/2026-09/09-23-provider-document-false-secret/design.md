# Design

## Root cause

供应商原始文档读取/保存共用字段名子串匹配。普通字段 `model_auto_compact_token_limit` 被 `token` 命中：读取时遮罩成字符串，保存新增字段时以 `provider_document_secret_edit_requires_key_manager` 拒绝。此前 issue #241 只修改了“通用配置”入口。

## Boundaries and discovery

- `src-tauri/src/features/providers/service/repository/support.rs`: `is_secret_key` 由文档、目录和预览共享；已核对影响，保持实现不变。
- `src-tauri/src/features/providers/service/repository/documents.rs`: 文档脱敏、保存拒绝、旧凭据保留及测试；主要修复点。
- `src-tauri/src/features/providers/service/repository/catalog.rs`: 共用判定，检查潜在影响；不做无关改动。
- `src/features/settings/components/providers/NativeProviderDocumentEditor.tsx`: 消费 `hasSecret` 和后端错误；确认无需在 UI 提示层打补丁。
- `src-tauri/src/features/providers/service/repository/common.rs`: 通用配置独立格式校验；保持现状。

## Proposed behavior

保持真实凭据由密钥管理器处理。仅在 `documents.rs` 的 TOML 文档判定里对精确字段 `model_auto_compact_token_limit` 豁免；Claude JSON、供应商目录和预览继续使用共用的保守判断，不一概放开含 `token` 的字段。TOML 脱敏、保存拒绝和旧密钥保留使用一致的判定。解析失败时仍保守隐藏潜在凭据；测试普通字段往返、已存密钥保护、新增密钥拒绝与 JSON 隔离。

## Risks and rollback

改变分类可能导致敏感值显示；只放行已确认的普通字段，其余沿用保护。无需数据库迁移，回滚本任务涉及的分类和测试改动即可。
