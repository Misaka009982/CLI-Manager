# Prototype generation prompt

Use case: ui-mockup

Asset type: high-fidelity desktop application settings screen, 16:9 landscape

Primary request: Design a realistic, implementation-ready provider management screen for a Windows Tauri developer tool named CLI-Manager. This replaces a read-only CC Switch browser with native management. Show manual multiple API keys, one active key only, a global provider selector, provider/common/effective configuration, environment checks, and CC Switch import.

Style/medium: polished production desktop UI, dark developer-tool theme using existing CLI-Manager-like theme tokens; restrained depth, rounded 12-16px cards, crisp borders, Lucide-style line icons, JetBrains Mono for code and IBM Plex Sans-like body typography. Not a marketing page and not concept art.

Composition/framing:

- Full 16:9 app window with a narrow existing settings navigation rail on the far left.
- Main page header: "供应商管理" and short subtitle "全局默认与项目覆盖均由 CLI-Manager 管理".
- Top segmented tabs: "Claude Code", "Codex", "Grok"; Claude Code selected. Each tab can show a small environment status dot.
- Top-right actions: "环境检查" and "从 CC Switch 导入".
- Show the Environment Check action opening a panel where users can choose "自动检测" or "手动 Home", browse for a directory, paste an absolute Windows/WSL UNC path, preview the derived `.claude`, `.codex`, and `.grok` targets plus their Hook and session-history directories, and click "恢复自动检测". State that Hook/history follow this Home by default, while explicit feature directories are preserved and marked "未跟随当前 Home" with a "跟随当前 Home" action. Selecting Home must not imply that provider files or Hooks are immediately rewritten.
- Near the global provider selector, show the real target path "写入 ~/.claude/settings.json", making clear this is a Home-level switch like CC Switch, not an internal app default.
- Main content is a practical master-detail layout.
- Left provider column about 30% width: search, "+ 新建供应商", cards for "Anthropic Official", "OpenRouter", "Company Gateway". Show text badges "全局", "草稿", or "停用" without relying on color alone.
- Right detail area header for "OpenRouter", with "设为全局" primary button and overflow menu. Show a small source summary: "全局：Anthropic Official" and "项目覆盖：3".
- Detail tabs: "概览", "Keys", "供应商配置", "有效配置"; select "Keys".
- Keys panel: compact table/cards with three masked rows: "Production  sk-or…91a7" marked "已启用", "Personal  sk-or…74c2" with an "启用" button, "Backup  sk-or…3bd8" with an "启用" button. Include "+ 添加 Key". Do not include health, quota, failover, rotation, automatic switching, validity testing, or usage graphs.
- Lower/right configuration summary: checkbox "继承 Claude Code 通用配置", small precedence strip "通用配置 → 供应商覆盖 → 当前 Key", and a code preview with tabs "供应商", "通用", "最终结果", "Live Diff".
- Include a small non-alarming info callout: "Key 以明文保存在本地 CLI-Manager 数据库；界面与日志默认脱敏。"
- Bottom status line: "切换对新启动进程生效，已运行终端保持不变。"

Color palette: charcoal/slate background (#0f172a-like), slightly lighter cards, off-white primary text, muted slate secondary text, blue-violet primary accent, green only for success, amber only for warnings, red only for destructive actions. Strong contrast and visible borders.

Text (verbatim): "供应商管理", "全局默认与项目覆盖均由 CLI-Manager 管理", "Claude Code", "Codex", "Grok", "环境检查", "从 CC Switch 导入", "写入 ~/.claude/settings.json", "新建供应商", "Anthropic Official", "OpenRouter", "Company Gateway", "全局", "草稿", "停用", "设为全局", "概览", "Keys", "供应商配置", "有效配置", "Production", "Personal", "Backup", "已启用", "启用", "添加 Key", "继承 Claude Code 通用配置", "通用配置", "供应商覆盖", "当前 Key", "供应商", "通用", "最终结果", "Live Diff", "Key 以明文保存在本地 CLI-Manager 数据库；界面与日志默认脱敏。", "切换对新启动进程生效，已运行终端保持不变。"

Constraints: readable practical hierarchy; no tiny illegible text; no horizontal journey; no glass-heavy effects; no brand logos; no emoji; no watermark; no mobile layout; no auto key rotation, failover, quotas, validity check, health score, or charts; one and only one active Key is visually clear; buttons and badges must have stable dimensions; show visible keyboard focus ring on one control.
