# 终端 emoji 宽度与 Pi 滚动条（#285/#286）

## Goal
修正终端与 CLI 的 emoji 占格不一致，并验证 Pi 常驻滚动条配置。
用户已于 2026-10-16 批准执行，版本为 V1.4.4。

## Confirmed facts
- 桌面 useXTermController.ts:1048 使用 Unicode 11；WebTerminal.tsx:159 使用 Unicode 6。
- Pi 将 ⚠️、家庭 ZWJ emoji、肤色 emoji 算作 2 格；桌面分别为 1/8/4 格。
- 与 xterm 6.1.0-beta.288 匹配的 graphemes 插件将以上样本修正为 2 格。
- rescaleOverlappingGlyphs 排除 emoji，不支持 DOM renderer。
- Pi auto scrollbar 替换最后一列，always 预留一列；桌面/Web 本身已有滚动条留宽。

## Requirements
- R1：两端新终端默认使用一致字素规则，覆盖 VS16、ZWJ、肤色、旗帜、CJK。
- R2：保留统一 Unicode 11 构建回退；不在已解析输出的终端切换算法。
- R3：分块、ANSI、光标、reset、resize、serialize/replay 不改写用户输出。
- R4：备份本机 Pi 配置，仅设置 fullscreenScrollbar=always，验证其他键不变。
- R5：更新 V1.4.4 CHANGELOG、功能清单与契约；按用户最终要求不保留独立兼容说明文档。

## Acceptance Criteria
- [x] emoji 表格边框 buffer 列对齐，两端接线一致。
- [x] 分块/整段输出具有一致文本、单元格宽度和光标。
- [x] reset、normal/alternate buffer、resize、serialize/replay 保持模式。
- [x] Unicode 11 构建回退可用，覆盖两端。
- [x] Pi 配置有备份、其他键不变，官方布局验证留列。
- [x] 定向测试、两端类型检查/构建、独立严格架构检查通过，列明人工视觉检查项。
- [x] 用户确认验证完成并授权提交（2026-10-16）。

## Out of scope
不修改 xterm scrollbar CSS、PTY/IPC、服务端、字体或输出字符。
不自动改其他用户 Pi 配置，不发布评论/关闭 issue，不宣称所有像素溢出已解决。
