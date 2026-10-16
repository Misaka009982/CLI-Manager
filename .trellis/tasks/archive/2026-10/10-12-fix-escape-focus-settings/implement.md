# 执行计划

- [x] 开始分支检查已报告：master 与 origin/master 0/0，工作区干净。
- [x] 根因定位、触点清单、场景矩阵与 PRD 收敛。
- [x] 用户审阅方案后回复“继续”，task.py start 已成功。
- [x] 按 trellis-before-dev 完成既有相关规范核对，修改设置 Esc 守卫和外壳焦点样式。
- [x] 添加隔离浏览器回归夹具，覆盖实际 SettingsModal Esc 事件与真实 Mantine keepMounted 抽屉；避免启动桌面应用或访问真实配置。
- [x] 修复前回归失败：外壳 outline 为 auto、隐藏抽屉阻挡关闭；修复后浏览器测试 6/6 通过。
- [x] 定向 Node 测试：settings Escape 浏览器回归 6/6；extensionsMcpSaving、extensionsSettingsLayout、workspaceBackgroundLayout 合计 20/20。
- [x] 运行 `npx tsc --noEmit`（通过）和独立的 `npm run check:architecture -- --strict`（1298 文件，零超长/违规）。
- [x] 同步 V1.4.4 CHANGELOG 与功能清单的工作区/远程连接板块；交互契约写入 frontend/hook-guidelines.md。
- [x] 复核 git diff、记录验证证据与原生应用未验证的范围；用户已授权归档任务，并将修复、归档与日志合并为一个提交。

Git diff 已复核且 diff --check 通过；验证和提交清单见 verification.md。归档与日志使用 --no-commit，随本次修复一起提交。

## 风险与回退
不移除 keepMounted，不修改全局 Esc、PTY、焦点陷阱或 App 状态。若子层关闭测试失败，先修正事件归属判定，不以全局阻断冒泡或隐藏所有焦点提示绕过。需要原生桌面人工验收时明确报告，不把隔离浏览器测试声称为完整 Tauri 测试。
