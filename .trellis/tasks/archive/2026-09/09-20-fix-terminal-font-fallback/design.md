# 字体修复设计

## 根因
运行时 normalizer 把额外字体强行插到用户 generic monospace 前，且选择器持久化这一派生结果。修复落在字体偏好规范化、运行时回退与设置保存边界；不靠 xterm 重建或 UI 样式覆盖补丁。

## 决策
1. 分离用户偏好规范化和运行时字体栈构建。用户前缀保持优先级，通用等宽字体不得被新增比例字体抢先。
2. 移除全局无条件注入的 CJK 栈。浏览器按字形执行原生回退：字体未安装/无法加载/缺字才选择后续字体。空偏好使用现有 Cascadia Code、Consolas、monospace 默认值；保留必要的终端符号兜底，但不前置到用户已选字体栈之前。
3. 复用 shared/platform/systemFonts.ts 的 CSS 字体串解析/序列化，正确处理引号内逗号，不再直接 split(',')。如需导出已有解析器，保持其算法语义不变。
4. 旧配置仅对能够确认的完整自动追加尾部指纹进行清理：Powerline/CJK 固定顺序及 generic 尾部组合。保留前面的用户选择；不单凭 Microsoft YaHei/PingFang 字体名删除。不能确认的混合/手工编辑配置保留，可通过重新选择字体保存纯偏好恢复。
5. 设置选项值、当前值匹配与保存使用同一偏好 normalizer；只有 xterm 与预览使用运行时 normalizer。加载时不批量重写持久化，不引入版本迁移字段。
6. 不使用字宽“看起来不正常”判断，也不轮询 canvas 检测。已安装但字体自身存在渲染缺陷不能仅凭系统字体列表可靠诊断，不自动覆盖用户选择。

## 发现清单与影响
| 触点 | 处理 |
|---|---|
| terminal/api/terminalFontFamily.ts | 分离偏好与运行时，兼容旧注入尾部 |
| shared/platform/systemFonts.ts | 复用或显式导出 CSS token parser；不改变 UI 字体语义 |
| settings/.../ThemeSettingsPage.tsx | 当前选项匹配/保存改用纯偏好；预览保留运行时入口 |
| terminal/hooks/useXTermController.ts | 已有运行时入口与 fontFamily 热更新，无需重建终端 |
| StatuslinePreview.tsx / StatuslineSettingsPage.tsx | 复用统一运行时入口，验证无漏接 |
| shared/preferences/settingsStore.ts | 既有 fontFamily 加载保留；不新增全量迁移 |
| app/App.tsx 与 UI CSS | 已确认独立 uiFontFamily，不修改 |
| scripts/systemFonts.test.mjs | 删除锁死错误 CJK 排序的源码断言，改真实函数行为测试 |

GitNexus：normalizeTerminalFontFamily HIGH，5 个直接引用、8 个上游符号、3 组执行流程；修改前已向用户提示。实施阶段对新增涉及的既有符号补 impact。

## 场景与验证
- 用户字体存在/缺失/缺 CJK 或符号字形；英文、数字、中文、Powerline 字符混合。
- 默认、自定义单/多字体、monospace/ui-monospace、空值、逗号/空格/中文名称、旧完整尾部/不完整手改尾部。
- Windows/macOS/Linux 使用同一纯算法；不同字体安装结果由平台字体匹配处理。
- 本地/WSL/SSH、主目录/worktree、分屏/多会话、前后台与焦点只影响可见性，不改变字体策略；Hook 不参与。
- 运行时 JS 行为测试 + 可用浏览器/应用渲染检查；不得只以源码正则测试证明字形未变化。

## 回滚
限于字体模块、选择器保存与测试；不触碰 WSL 代码。不破坏用户存储，恢复代码即可回滚新逻辑。
