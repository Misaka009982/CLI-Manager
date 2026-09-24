# Web 自适应排版验证 · 2026-09-16

## 2026-09-17 统一共享查看追加

- 19 项显示/布局/光标视野/剪贴板/图片桥接测试通过，Web 类型检查通过，strict 架构零违规（1142 个源文件）。
- 统一入口接入实际 WebTerminal，旧镜像缩放不再参与布局；保持桌面优先的尺寸协议。
- 浏览器回归脚本已更新，真实 Safari 输入/拖动和设备控制权切换仍待安装测试；未启动应用服务。
- 旧记录中的 contain 选择框与自动 zoom 验收由最新统一字号/适合宽度方案取代。

代码修改及自动验证完成，浏览器真机验收待完成。本轮仅构建 Web 前端，未更新现有 NSIS 安装包，未启动任何应用或服务。

## 已通过

- `node --test scripts/webTerminalLayout.test.mjs scripts/webTerminalDisplay.test.mjs scripts/webTerminalClipboard.test.mjs scripts/webTerminalImageBridge.test.mjs src/shared/lib/webTerminalFrames.test.mjs src/shared/lib/webTerminalBackpressure.test.mjs src/shared/lib/webSubagentSnapshot.test.mjs`：33 项通过。
- `npm --prefix apps/web run typecheck` 与 `npm --prefix apps/web run build`：成功。保留既有 >500kB chunk 警告；本次 Web JS 为 index-BbXuX6bj.js。
- `npm run check:architecture`、`npm run check:architecture -- --strict`：1141 个源文件，零超限、零违规。
- `node --check scripts/webTerminalRenderer.smoke.mjs`：成功，仅语法验证，不代表浏览器场景已经运行。
- `git diff --check`：成功。
- 源码复核：applyTerminalDisplay 接入 reportSize；滑块/加减/滚轮依据所有权调整字号或镜像缩放；桥接仍在桌面视口可见时拒绝 Web resize。输出解析、输入/图片/关闭业务没有修改。

## 自动测试覆盖与边界

- 布局测试用可测量的终端模型调用真实布局函数，覆盖多字号、三种旧镜像模式、旧 60% 缩放、手机键盘/工具栏剩余空间、分屏、重复布局及所有权往返。它不能证明 Safari 实际排版或真实 CLI 重绘正确。
- 浏览器回归脚本已追加真实组件入口的调字号/区域不变、隐藏标签、重新激活、resize 去重断言；由于项目禁止代理启动 UI，未执行脚本。
- 图片桥接测试首次失败因旧 src/hooks 路径 ENOENT，修改为已存在的 features 路径后通过，断言未削弱。
- GitNexus 无可用索引；memory 更新后已查到新增函数与调用，最终结论以源码及执行测试为准。

## 待人工验收

1. Web 控制尺寸时，8/14/24/36px 切换：外层窗口固定，字号真实变化、行列相应增减；宽高设为 100% 时仅允许单个字符/行的取整余量，超大屏仍受既有 500 列/300 行限制。
2. 桌面重新控制时，仅显示镜像适配选项；桌面终端尺寸不受网页调字号影响。镜像本身仍可能留白/溢出，这是共享固定行列的限制。
3. 手机 Safari 键盘和工具栏展开/收起、横竖屏、子代理分屏、标签切换、断线重连：输入行可达，不黑屏、不反复重绘、不串会话。
4. 中英文切换；复制粘贴文字、图片上传、关闭语义回归。

## 发布边界

本轮修改仅 Web 前端和测试/文档，不修改后端协议或数据库。现有安装包尚未包含这些修改；后续若封装，按用户要求仅 NSIS，先提交再封装，保留旧包以便回退。
