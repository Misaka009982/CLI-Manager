# Design

## Root cause
#286 根因在 CLI 字素宽度与终端宽度服务边界：桌面 Unicode 11 缺少部分组合，
Web Unicode 6 又与桌面不同。修复在两端初始化阶段安装相同 provider，先于 live/replay。
#285 遮挡来自 Pi auto scrollbar 的最后一列覆盖；always 在 Pi 布局源头留列。

## Architecture
- 新增 src/shared/lib/terminalUnicode.ts；默认安装 15-graphemes。
- 根包和 Web 显式依赖 addon-unicode-graphemes 0.5.0-beta.288，保留 Unicode11Addon。
- 两端 allowProposedApi=true，在 open/write 前安装；每个 Terminal 独立 addon，由 xterm dispose。
- VITE_TERMINAL_UNICODE_MODE=unicode11 为构建回退，两端必须同值重建、重开终端。
- 不加运行时下拉或持久化协议，不 catch 后静默选择不同 provider。
- Web query policy 和 PTY resize/ownership 不变。
- Pi 仅修改当前用户实际配置，备份原字节，不修改第三方包。

## Discovery list
- [x] useXTermController：初始化，影响 XTermTerminal / PaneLeafView。
- [x] WebTerminal：初始化/reset/replay，影响 Workbench / App。
- [x] useTerminalDisplay / terminalLayout：已留宽，确认无须改动。
- [x] terminalQueryPolicy：开启 proposed API 不改变应答归属。
- [x] SerializeAddon/replay：真实依赖测试模式一致性。
- [x] DOM/WebGL/background：宽度服务独立于 renderer，像素效果留人工验收。
- [x] Rust/daemon/SSH/WSL：原始输出传递无须变更。
- [x] Pi ScrollView/layout：验证 always 留列，不改上游。
- [x] i18n：不新增产品 UI 文案，不依赖界面语言。

GitNexus 两入口 upstream impact 均 LOW，各一个直接 caller、无已索引流程。
上一轮刷新因 FTS 失败，结合当前源码核对，不视为完备运行时覆盖。

## Scenarios
- ASCII/CJK、VS16/ZWJ/skin tone/flag、组合重音、ANSI。
- 整段、字符边界、任意 UTF-8 分块。
- 初始化/reset/normal/alternate/resize/serialize/replay/dispose/remount。
- DOM/WebGL、背景图、主题、字号、分屏/全屏/焦点模式：人工像素确认。
- PowerShell/WSL/SSH/worktree/hook 有无走相同 provider。
- 隐藏/最小化/跨窗口不改变 provider；Web 镜像/接管规则一致。

## Rollback and limits
两端相同构建回退值并重开终端。历史旧算法输出重排不承诺与旧版完全相同。
插件为实验性，buffer 修复不代表所有字体像素溢出已修复。
Pi 恢复备份时保留验证后新增设置。本任务按一项终端兼容修复交付，
Pi 为配套本机验证和配置操作，不扩展独立产品能力。
