# 验证与交付记录

## 修复结果
- 外壳保留程序化焦点，但不绘制浏览器在 Esc 后启用的默认 focus-visible outline。
- 设置只因可见的其他 dialog/alertdialog 或当前事件所属子弹层而让出 Esc；隐藏 keepMounted 抽屉不阻止退出。
- defaultPrevented/IME 事件不关闭设置；事件 composedPath 保留同步卸载弹层的键盘事件归属。
- 根因、场景矩阵和全部代码触点（含确认无关的 PTY/远程服务）见 design.md。

## 已执行验证
- 修复前隔离 Edge 回归：工作区/设置外壳 outline=auto，远程连接主页按 Esc 未卸载设置，证明原始缺陷。
- `node --test scripts/settingsEscape.browser.test.mjs`：6/6 通过；实际 SettingsModal/SettingsLayout/useFocusTrap/i18n 与真实 Mantine Drawer/Modal，远程业务页由夹具代替。
- 浏览器覆盖：Tab 按钮焦点、zh-CN/en-US × light/dark、两个 keepMounted 抽屉、Modal、200ms/0ms 关闭、捕获阶段同步卸载、preventDefault、IME、alertdialog、display:none 祖先、visibility:hidden。
- `node --test scripts/extensionsMcpSaving.test.mjs scripts/extensionsSettingsLayout.test.mjs scripts/workspaceBackgroundLayout.test.mjs`：20/20 通过。
- `npx tsc --noEmit`：通过。
- `npm run check:architecture -- --strict`：1298 个源文件；0 超过 2000 行；0 新违规。
- `git diff --check`：通过。
- GitNexus impact 查询未识别符号，索引刷新被原生 worker 错误阻挡，已按分诊规范降级源码核查；detect_changes 返回 low，但旧索引未识别改动符号，不将其作为完整覆盖证据。

## 原生人工验收范围
按项目规范未启动 Tauri/CLI-Manager 服务。需人工确认：空终端工作区点击空白后按 Esc 无外框；设置远程连接首页 Esc 退出；两个抽屉均先退出抽屉、再按 Esc 退出设置；正常终端/TUI Esc 语义以及标准/紧凑/全屏下 Tab 焦点提示正常。

## 提交清单（用户已授权合并提交）
一个工作提交：`fix(settings): 修复 Esc 退出与页面焦点边框`

- `src/features/settings/api/SettingsModal.tsx`
- `src/styles/components/focus-controls.css`
- `scripts/settingsEscape.browser.test.mjs`
- `scripts/fixtures/settingsEscape.html`
- `scripts/fixtures/settingsEscape.tsx`
- `scripts/fixtures/settingsEscapePage.tsx`
- `scripts/fixtures/settingsEscapeStore.ts`
- `.trellis/spec/frontend/hook-guidelines.md`
- `CHANGELOG.md`
- `docs/功能清单.md`
- `.trellis/tasks/archive/2026-10/10-12-fix-escape-focus-settings/` 的任务记录
- 本次任务对应的 `.trellis/workspace/hxx/` 日志及索引

无未识别的脏文件。用户后续明确授权“可以归档任务合并提交”；按该指示把修复、归档和日志合并为一个提交，不推送远程。
