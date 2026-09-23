# Implementation plan

1. 核对代码图谱影响与真实源码触点，用无密钥 TOML 复现误判；记录影响范围。
2. 在后端分类处做最小根因修复，保证读取、保存与凭据保留行为一致；避免修改无关入口。
3. 增加普通配置回显/保存及真实密钥防护回归测试；运行定向 Rust 测试、`cargo check`（如环境允许）、`npm run check:architecture -- --strict`；核对差异和调用影响。
4. 更新 `CHANGELOG.md`（用户未指定版本时先询问，仍未指定用 `TEMP`）和 `docs/功能清单.md` 中供应商板块。提交前检查变更影响，交付时说明验证、风险与回滚。

## Implementation gate

用户已确认实施，任务已启动。用户未指定变更记录版本，按仓库规则暂记 `TEMP`。

## Verification

- `cargo test provider::repository::documents::tests --lib`：15 项通过，覆盖 TOML 普通字段往返、真实密钥防护和 Claude JSON 隔离。
- `npm run check:architecture -- --strict`：0 超限、0 新违规。
- `git diff --check`：通过，仅有仓库 CRLF 转换提示。
- `cargo check --lib`：通过。
- GitNexus MCP/本地技能文件在本轮未提供；按项目降级规则使用当前仓库代码图谱（调用者/风险分析、重建索引及变更影响）、供应商契约文件、源码与 Git diff 交叉复核。
- 未访问用户真实供应商数据；用户未要求构建安装包。
