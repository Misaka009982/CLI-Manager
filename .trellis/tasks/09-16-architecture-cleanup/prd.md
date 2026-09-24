# 架构规范清理与测试包

## 目标与根因

目前 strict 检查报告 38 项：25 项单行超过 500 字符、2 个模块超过 2000 行、11 项 shared 反向引用 features。根因是模块职责/依赖方向与现有架构契约不一致，以及历史紧凑排版；应在职责归属与真实调用入口修复，不改阈值、baseline、排除目录或用转发绕过。

## 实施与发现清单

- Web 管理页面、项目树、视图、字典和两项测试：局部格式化，保持 JSX 空白、字符串及执行逻辑。
- useSidebarController：抽取完整尺寸/折叠/视口自适应 hook，保持 SidebarView 契约和拖动持久化时序。
- web_daemon：分离 URL 校验安全策略及对应测试，保留现有命令接口。
- shared/webManagement：该模块是业务编排而非公共工具，迁至 terminal 功能域并更新 Web bridge 与测试入口，保留权限、确认和调度顺序。
- shared/webTerminalFrames：帧结构归入 shared/types，传输层与编码层共用唯一类型。
- shared/terminalColorQueryFilter：OSC 终止符纯解析能力下沉 shared，桌面解析与 Web 过滤复用同一实现。
- 保持 Web API、PTY 协议、数据库、翻译键值、CSS 顺序、事件处理与存储键不变。

## 验证与场景

- 每批定向测试；前端类型检查/构建、Rust 定向测试、独立 strict 架构检查零违规。
- 模块迁移前后对照：Web 管理权限与确认、终端输出/回放/ACK、OSC 分块/损坏序列与剪贴板、侧栏拖动/折叠/窄视口/持久化。
- 焦点、分屏、多会话、Worktree、WSL/SSH、hook 状态不应因纯结构改动改变语义；保留既有入口与参数。
- UI 运行验证按项目规则由用户人工测试，代理不启动应用。
- 提交后重建桌面与 Web 资源和受影响 Rust 二进制，交付 NSIS 安装包，不打 MSI、不推送。

## 工具降级

GitNexus impact 返回 No indexed repositories found，项目引用的 GitNexus skill 文件亦缺失；使用 codebase-memory 索引定位，结合源码、rg 和 Git diff 复核，不以索引代替真实证据。
