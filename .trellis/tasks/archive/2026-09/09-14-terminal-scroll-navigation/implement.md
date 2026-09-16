# Implementation plan

## Gates

- [x] Git 只读同步检查：fix/pr-259-review-findings 与本地 upstream 记录一致（0/0），任务开始时工作区干净；已向用户报告。
- [x] 用户授权创建任务，版本记录 V1.4.0。
- [x] 定向定位截图组件、Radix 隐藏滚动条原因、已有 xterm 跳转入口与当前正文容器。
- [x] 收敛 PRD；补全设计、触点清单与场景矩阵。
- [x] 用户在续接会话中明确指定继续本任务并在 master 分支实现；已安全切换，master 与 origin/master 为 0/0。

## Ordered work

1. 读取 trellis-before-dev 所需组件、注释规范与相关领域契约；核对本任务 artifacts。
2. 对将改动的 MarkdownPreviewAnswerSelect、TerminalMarkdownPreview 及新增涉及的既有符号运行 GitNexus upstream impact，使用当前仓库绝对路径，报告直接调用、流程与风险；HIGH/CRITICAL 先告知。必要时 context 补足调用关系。
   先修复追加的加载故障：精确已命中会话读取避免排队等待全局索引，保留普通搜索、缺失会话和脏目录的刷新；补充后端定向回归。
3. 修复历史列表滑块呈现和高度约束，增加固定“跳到列表末尾”入口，保留选择与焦点。
4. 添加正文回到底部按钮及作用域内的可见状态维护，与字号控件错开。
5. 添加标题栏最新回答按钮，处理渲染后跳转、已选最新、切换取消与空状态。
6. 同步中英翻译、V1.4.0 CHANGELOG 与功能清单。
7. 完成定向测试和质量门禁后自审 diff，记录未完成的真实桌面验收。

## Validation

- 添加有意义的行为测试：两预览实例隔离；当前回答到底不改选择；选择最后真实 messageIndex 并在渲染后滚动；取消过期跳转；内容/容器变化后按钮显隐；菜单到底不改选择且保留打开。
- `node --test scripts/terminalMarkdownPreview.test.mjs scripts/terminalScrollToBottom.test.mjs scripts/terminalPreviewTheme.test.mjs scripts/historyMarkdownRendering.test.mjs scripts/terminalBackgroundLayout.test.mjs`，追加本次新增行为测试文件。
- `npx tsc --noEmit`。
- 独立运行 `npm run check:architecture` 与 `npm run check:architecture -- --strict`，不新增豁免。
- 依据最终变化范围执行必要前端构建，`git diff --check` 及交付 diff 审查。
- 历史查询策略变更执行相关 Rust 定向测试及 `cargo check`。
- 遵守 quality-guidelines.md 的桌面验证规则，不自行启动应用；真实菜单拖动、键盘、深浅主题、窄窗口、分屏、中英切换与 24 小时格式由桌面验收确认，如未执行必须明确披露。

## Completion

运行 trellis-check；必要规则仅在确有可复用契约时更新。遵循 trellis-finish-work 记录会话；没有用户提交授权不执行 commit。若后续明确要求提交，提交前先运行 gitnexus_detect_changes。

## Execution status — 2026-09-14

- [x] master 分支实现；原有二维码图片修改保留，依赖版本不变。
- [x] 精确历史会话查询先读后按需刷新，修复预览被全局刷新阻塞。
- [x] 历史菜单覆盖层滑块、固定列表末尾、正文到底、最新回答跳转。
- [x] 真实 Hook/组件回调验证滚动、重复跳转、延迟渲染、键盘、实例隔离、过期请求与 SSH context 清理。
- [x] 中英翻译、V1.4.0 双份记录、前后端契约更新。
- [x] 定向回归、TypeScript/前端构建及 Rust 编译通过；详细证据见 `verification.md`。
- [ ] 全仓架构门禁：normal/strict 均为 master 既有 38 项违规，本次未新增；未扩展为无关架构重构。
- [x] 用户于 2026-09-14 反馈“验证成功”；记录用户验收通过，代理未自行启动应用或声称逐项实测。
- [x] 用户授权后快进合并远程 master 至 e6c2e61a，完成合并复验与提交范围检查，代码提交 ca2151a8；任务归档与会话日志由收尾脚本记录。
