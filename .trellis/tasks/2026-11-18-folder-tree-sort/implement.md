# 实施方案：文件夹独立排序与偏好

## 目标与授权

以同目录 `prd.md` 的 R1–R10 和 `design.md` 的 KTD1–KTD10 为准。
用户已确认子目录继承父级且允许覆盖；实施与提交推送待方案落盘后确认。
当前基线为 `6fe6a33f`，现有集成 worktree，无需改动主 worktree 或旧未跟踪任务。
本轮仅静态核查；回归用例编写后由用户执行，不主动编译、运行测试、安装或启动界面。

## U1：建立作用域与继承排序

- 需求：R2–R5、R7、R9；决策：KTD1–KTD3、KTD5、KTD9、KTD10。
- 文件：`src/shared/lib/fileTreeSort.ts`、新增 `src/shared/lib/fileTreeSortOverrides.ts`、新增 `src/features/files/lib/fileTreeSortScope.ts`；测试 `scripts/fileTreeSort.test.mjs`、新增 `scripts/folderTreeSort.test.mjs`。
- 方式：复用现有比较器，双参数入口保持兼容；按项目与实际文件根生成 scope，递归传播规则，单独提供按路径查找有效规则及来源的纯函数。
- 模式参考：`fileContentRoot`、`fileOperationRootKey`、`isFileExplorerIgnoreCaseInsensitive`，共享层不导入功能域。
- 测试场景：
  - AE1、AE2：父级继承、嵌套覆盖、恢复继承、同级隔离及后代覆盖保留。
  - AE3：与继承值相同的显式选择仍固定规则；随后改变全局不影响该目录。
  - `src` 与 `src2` 不混淆；空树、未加载 children、冻结原树及文件本身的顺序保持正确。
  - 四种排序、目录优先、相同/未知修改时间仍遵循原契约。
  - 同项目不同 Worktree 根、不同项目同根、Windows 路径大小写等价、WSL/POSIX 大小写不同、SSH 主机/远程根不同均隔离正确。
  - 缺失、数组、非法枚举、越界路径和危险对象键不进入有效规则；合法记录保留。
- 验收：纯逻辑可静态追踪，原双参数用例不放宽断言，新用例表达全部规则；未执行不得记为通过。

## U2：接入持久化、备份及串行写入

- 依赖：U1；需求：R4、R5、R7、R8、R10；决策：KTD1、KTD4、KTD5、KTD10。
- 文件：`src/shared/preferences/fileTreeSortPreference.ts`、`src/shared/preferences/settingsStore.ts`、`src/features/sync/lib/syncSettings.ts`；测试 `scripts/folderTreeSort.test.mjs`、`scripts/fileTreeSort.test.mjs`，必要时新增 `scripts/folderTreeSortPreference.test.mjs` 以真实 store 接线隔离平台依赖。
- 方式：全局、目录覆盖和 reset 共用队列，每次出队时读最新设置；保持旧 `updateFileTreeSort` 入口，Settings 只留新字段/default/migrate/update 接点，分类为 preferences。
- 测试场景：
  - AE6：同一目录先改维度再改方向、不同目录/不同 scope 连续保存，均不丢其他记录。
  - 全局更新尚未完成时创建目录覆盖，出队读取更新后的继承值。
  - reset 与 set 交错按顺序生效；删除最后覆盖可清空 scope，但保留其他项目/后代规则。
  - 首次写入失败保留旧状态，错误传播且后续重试成功；无目标/偏好未加载不写盘。
  - AE5：排队后切换项目，操作仍固定原 scope，不将旧值写入新项目。
  - 旧配置仅含全局设置时默认无覆盖；加载和备份导入均过滤非法形状；重启/导出恢复保留合法值。
- 验收：所有面板使用唯一更新入口，无来自旧渲染的整表写入；`settingsStore.ts` 不超 2000 行。

## U3：文件夹行箭头与菜单

- 依赖：U1、U2；需求：R1、R6–R10；决策：KTD6–KTD9。
- 文件：新增 `src/features/files/components/FolderTreeSortMenu.tsx`、`src/features/files/components/FileTreeSortMenu.tsx`、`src/features/files/api/FileExplorerSidebar.tsx`、`src/styles/components/file-editor.css`、`src/shared/i18n/messages/files.zh-CN.ts`、`src/shared/i18n/messages/files.en-US.ts`；新增 `scripts/folderTreeSortUi.test.mjs`、`scripts/folderTreeSort.browser.mjs` 及 `scripts/fixtures/folderTreeSort.tsx`，核对 `scripts/fileExplorerMultiSelectUi.test.mjs`、`scripts/terminalFilePointerDrag.test.mjs`、`scripts/fileExplorerInitialLoad.test.mjs`。
- 方式：FileNode 的行激活区域与排序按钮并列，复用排序菜单；紧凑链使用已有 chainPaths 提供作用目录；树投影使用同一作用域规则，搜索分支不改。
- 测试场景：
  - AE4：普通目录与紧凑链各级可选择/恢复；默认末级、显式覆盖状态与有效方向一致。
  - 真实控件的 pointerdown/click/doubleclick/keydown/contextmenu 和 Portal 菜单操作不触发文件行选择/展开/拖拽或根复制粘贴/删除快捷键。
  - 键盘激活、上下键/Home/End、Esc 关闭与焦点恢复正确，触摸按钮可用；不通过笼统 preventDefault 破坏默认可访问性。
  - 保存中禁用、失败重试、切换项目/根/目录链关闭旧菜单；旧保存不覆盖新 UI。
  - 侧栏和嵌入面板均接入；SSH 只读目录能保存本地排序，文件和搜索结果不增加排序控件。
  - 排序前后选中、展开、重命名及编辑器脏内容不变，不额外触发目录/Git 请求；长名称、Git 标记和窄面板无覆盖。
  - 全局顶部菜单保持现有行为；中英文新增键完整且无硬编码用户文案。
- 验收：以真实 TSX/菜单与更新器组合写测试，事件链至少有真实 DOM 冒泡用例，不仅检查源码字符串；运行及实机结果留待用户，不以夹具存在替代通过。

## U4：契约、记录与静态验收

- 依赖：U1–U3；需求：全部。
- 文件：`.trellis/spec/frontend/file-tree-sort-contracts.md`、`CHANGELOG.md`、`docs/功能清单.md`、本目录 `verification.md` 与 `task.json`。
- 更新契约中的唯一真值、递归规则、队列和测试范围；版本记录采用用户确认版本，未指定时用 TEMP，不自动提升 npm/Tauri/Cargo 版本。
- 核对所有新增入口的导入、导出、路径身份、事件边界、旧全局兼容及 backup 分类。
- 检查 Git 差异/冲突/空白、UTF-8、脚本纯语法、变更手写文件 2000 行上限及单行 500 字符上限；无关格式、后端、其他功能不改。
- 单代理审阅与独立复审分开记录；无子代理/GitNexus 或缺失 TypeScript 时明确标注，不安装依赖补环境。
- 只在用户确认本轮提交/推送时执行，并检查远端快进条件；不把上一轮授权当作本功能的授权。

## 验证契约与完成标准

| 项目 | 完成信号 |
|---|---|
| 产品规则 | R1–R10 在代码中有明确接点，AE1–AE6 均有对应回归或手工场景 |
| 行为覆盖 | 纯逻辑、串行持久化与真实 UI 冒泡链都有针对性测试；运行结果与未运行分开 |
| 结构 | 新业务规则位于独立 helper/component，Settings/Sidebar 保留薄接线，变更文件不超限 |
| 兼容 | 全局旧配置、搜索、文件操作、展开/选择、慢 Git 首屏和 SSH 只读均不回归 |
| 交付记录 | 契约、双语文案、版本记录及 verification 与最终实现一致；没有试验遗留代码 |
| 运行边界 | 本轮只静态检查，不宣称 build、类型、DOM 或实机验收通过；完整架构旧欠项不冒充清零 |

用户后续在依赖齐备的 worktree 执行已有构建/严格架构检查以及文件排序、目录排序、偏好、UI、文件多选/拖拽和首屏回归。
新 UI 处理器回归沿用现有 TypeScript AST/VM 夹具；真实 DOM 冒泡由独立 browser 回归负责，复用 `scripts/subagentConversation.browser.mjs` 的 `PLAYWRIGHT_MODULE` 与已有 Edge 入口，不新增依赖或自动下载浏览器。两类脚本本轮都不执行；用户缺少已有浏览器工具时，明确记录未验证并提供人工验收步骤，不能将处理器隔离测试当作 DOM 集成通过。

## 文档审阅

本方案在当前上下文按一致性、可实现性、交互和反例场景复核：明确“目录内部排序”和“目录在父级的位置”不同，补齐同值固定、作用域捕获、紧凑链中间级恢复与 Portal 事件边界。
补明确处理器隔离回归和真实 DOM/browser 回归的不同证据边界，避免项目未声明浏览器依赖却要求新安装；其余规则与原排序契约一致，未发现阻塞实施的矛盾。
未派发子代理或外部模型，不声称独立复审通过。产品继承选择已确认；下一步仅需确认实施/交付及版本记录范围。
