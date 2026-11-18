# 文件夹独立排序：实现与静态验收

日期：2026-11-18。
代码工作区：`D:/Project/pi-pet/CLI-Manager/.worktrees/ship-desktop-pet-e-master`。
分支：`feat/folder-tree-sort`；起点：`6fe6a33fd42b5cecbf8e4b8b3efe4e44db25c201`。

## 授权与交付边界

三份方案落盘、单代理审阅后，用户确认“实施并推送 origin/master”。
本轮变更记入 V1.5.1 fork 小节，不提升 npm/Tauri/Cargo 版本，不创建 PR 或发布标签。
实施、回归编写和静态核查完成；编译、测试、浏览器、安装和实机验收均未执行，留给用户。
功能提交：`19650f5c32437e716aecd5cd48d8fe0ccdfb8bac`（`feat(files): 支持文件夹独立排序与继承偏好`）。
提交后的最终路径追踪补齐了同任务的自绘指针落点守卫，未改写既有提交；完整交付以最终 HEAD 和 Git 回执为准。
提交前远端 master 为起点 `6fe6a33f`，功能提交直接基于该起点；仅使用普通快进推送，实际远端结果以最终 Git 回执为准。
主 worktree、旧未跟踪 `10-14-pi-question-adapters/`、Pi/rpiv 与已安装副本未改动。

## 实现与需求对应

| 实施单元 | 完成内容 | 需求与验收示例 |
| --- | --- | --- |
| U1 | `fileTreeSortOverrides.ts` 管理安全覆盖、相对路径和最近祖先；`fileTreeSortScope.ts` 复用实际文件根；旧双参数排序入口保留 | R2–R5、R7、R9；AE1–AE3、AE5 |
| U2 | `fileTreeSortPreference.ts` 让全局/目录/reset 共用队列，出队读真值；Settings 增加空覆盖默认、加载/写入校验及 preferences 备份分类 | R4、R5、R7、R8、R10；AE3、AE5、AE6 |
| U3 | 独立 `FolderTreeSortMenu` 会话、紧凑链各级目标、来源与恢复；文件行激活区和按钮并列，Portal/拖放隔离，保存/失败/焦点与迟到回执守卫 | R1、R6–R10；AE4–AE6 |
| U4 | 更新排序契约、V1.5.1 变更记录、功能清单和本记录；复核代码长度、导入、国际化与兼容边界 | R1–R10 |

### 已保留的产品决策

- 目录规则只改变内部及未覆盖后代的显示顺序，不决定该目录在父级的位置。
- 最近显式祖先优先；全局和父级变更不删除子级覆盖，同值选择也能固定规则。
- 恢复继承仅删除目标项；紧凑链默认末级，但菜单可选择中间级。
- 按项目、实际根和目录隔离，Windows/普通 UNC 折叠大小写，WSL/POSIX/SSH 保留大小写，SSH 主机/远程根独立。
- 排序不修改源树、选择、展开或编辑缓冲，不启动目录/Git 请求，不改变两种搜索结果顺序。
- 路径改名/移动不追踪旧身份，不根据未展开树自动清理保存记录；SSH 只读树可保存本地排序偏好。

## 静态核查结果

| 检查 | 实际结果 | 不代表什么 |
| --- | --- | --- |
| Git 空白与未合并项 | `git diff --check` 通过，未合并项为空 | 不等于行为回归通过 |
| 严格 UTF-8 | 31 份交付变更文本（含本记录和 task.json）严格解码通过，暂存与工作区一致；提交号补记仅涉及本记录和 task.json，另行静态复核 | 不修复无关旧历史 |
| 冲突文本 | 本轮未引入冲突起止/分隔标记；功能清单唯一既有 `=======` 保留 | 不宣称全仓文本没有历史分隔符 |
| 手写长度 | 23 份代码文件均 ≤2000 物理行、单行 ≤500 字符；最长 `settingsStore.ts` 1989 行，`FileExplorerSidebar.tsx` 1842 行 | 不是全仓严格架构检查 |
| JavaScript | 8 份变更 `.mjs` 的 `node --check` 通过，包括旧排序/路径菜单、新回归和两个夹具 helper | 没有执行脚本、导入测试依赖或启动服务器 |
| 非 TSX 的 TypeScript | 9 份 `.ts` 经 Node 内置 `stripTypeScriptTypes` 的 strip 模式解析，无产物、无源码执行 | 不是 TypeScript 类型检查，也未解析 TSX |
| 导入与层级 | 100 个字面量相对导入目标存在；本轮共享模块未新增 features/app 反向导入，命名导入人工核对 | 不是完整 AST 导入图或动态解析证明 |
| 国际化 | 两种语言的 16 个 `files.sort.*` 键一致且无重复，新增 6 键齐备 | 中英文实机切换未执行 |
| 版本及范围 | npm/Tauri/Cargo 版本文件、后端、Hook、Web/Tap 代码和依赖清单不在改动集 | 新功能不会自动进入已安装应用 |

普通 `node --check` 不处理本环境的 TypeScript 类型标注，改为内置解析 API；该 API 自身输出实验性警告，未隐藏 stderr。
Git 中文路径默认引号转义，文件清单检查使用本次命令的 `-c core.quotepath=false`，未改全局配置；读取错误立即终止，不将失败计为通过。
功能清单的既有分隔线可追溯到 `524fe2d66`（2026-09-15），基线 `6fe6a33f` 第 404 行，本轮移动到第 410 行但内容未变；没有配套冲突起止标记。

## 审阅覆盖与限制

- `ce-simplify-code` 的复用、质量、效率检查在同一上下文执行；保留已有文件根和比较器、独立 helper、输入校验、队列恢复及可访问性守卫，未追加无关重构。
- 当前 harness 没有子代理/原生独立 review 接口，跨模型宿主及提供方均无法按协议确认，独立模型审阅未运行、没有代码外发。
- `ce-code-review` 完整独立派发流程不可用，按交付降级规则进行了单代理静态差异扫描，覆盖继承错层、路径身份、非法偏好、串行写失败、Portal 传播、焦点和旧回执。不计作独立复审通过。
- 扫描期间补齐了箭头 dragover/drop 的根操作隔离、保存期间 Esc 焦点恢复、旧 Portal 接线断言和夹具目录必需字段。最终路径追踪发现自绘指针捕获不会经过目标控件的冒泡拦截，已在坐标落点查询排除箭头/目录排序弹层，并补充真实 DOM 的正反落点断言；没有已确认的本轮阻塞缺陷残留。
- GitNexus runner 缺失，未安装/引导索引器，未执行图影响或 detect-changes，不把文字交叉引用当作图分析通过。
- 未运行 `npm run build`、类型/Lint、严格架构检查或任何测试。当前 worktree 缺少 TypeScript/esbuild/Playwright 依赖；未改的 Rust broker 既有长度欠项保持原样，不宣称全仓零超限。

## 回归证据

### 已检查的既有回归

- `fileTreeSort.test.mjs`：原四种排序、自然名称、目录优先、时间异常/0、冻结源数据、旧更新器和双参数入口保留；仅更新新接线相关断言并增加约束，未放宽纯逻辑期望。
- `fileExplorerPathActions.test.mjs`：新增目录排序 Portal 后计数从 4 改为 5，并断言同一挂载点；其余菜单、路径和拖拽契约保留。
- `fileExplorerMultiSelectUi.test.mjs`、`terminalFilePointerDrag.test.mjs`、`fileExplorerInitialLoad.test.mjs`：处理器选择快照、捕获拖拽、慢 Git 首屏与项目代际边界未被本轮改动，作为用户待运行的兼容回归。

### 新增回归（全部未运行）

- `folderTreeSort.test.mjs`：纯排序/继承/覆盖/同值固定/恢复、连续队列和失败、非法路径及记录；无需浏览器。
- `folderTreeSortPreference.test.mjs`：从实际源码提取默认/load/update，运行完整偏好接线，只有 Tauri/KV 被隔离；检查 Worktree/Windows/WSL/SSH 身份、备份恢复、慢保存和未加载拒绝。
- `folderTreeSortUi.test.mjs`：沿用 TypeScript AST/VM 提取真实保存及键盘回调，检查事件、默认行为、焦点导航、卸载守卫、行结构和双语；额外组合实际坐标查询和来源行投递，确认排序控件不移动文件、普通目录仍可投递。这是处理器隔离，不是 DOM 证据。
- `folderTreeSort.browser.mjs`、`fixtures/folderTreeSort.tsx`：真实 FileNode/FileTreeRows、排序投影、FolderTreeSortMenu、Popover/ContextMenu Portal、实际 Settings 更新体和共用队列；只隔离平台/文件服务。不复制排序实现，节点缺失时报错。
- 浏览器夹具覆盖双面板、紧凑链更换/中间级恢复、全局变化保留覆盖、键盘/触摸/右键/双击、原生拖放和实际 `elementFromPoint` 指针落点、失败重试、慢写后切根、重载、SSH、双语与窄布局；复用已有 `PLAYWRIGHT_MODULE`/Edge。要求已有 dist 样式包含本轮选择器，不自动构建应用、安装依赖或下载浏览器。

没有红/绿运行结果。纯逻辑最初先写用例，再写实现，但遵照本轮静态边界没有观察 red；后续回归同样仅编写和静态核对，不能用“用例存在”替代通过。

## 用户运行与实机验收

在依赖齐备的当前 worktree，由用户自行执行：

```powershell
node --test scripts/fileTreeSort.test.mjs scripts/folderTreeSort.test.mjs scripts/folderTreeSortPreference.test.mjs scripts/folderTreeSortUi.test.mjs
node --test scripts/fileExplorerPathActions.test.mjs scripts/fileExplorerMultiSelectUi.test.mjs scripts/terminalFilePointerDrag.test.mjs scripts/fileExplorerInitialLoad.test.mjs
npm run build
npm run check:architecture -- --strict
node scripts/folderTreeSort.browser.mjs
```

浏览器命令仅在已有 Edge/Playwright 工具及匹配当前源码的 dist 时执行；缺少工具时使用以下人工清单，不新增测试依赖。

1. AE1–AE2：全局名称升序，`logs` 日期降序，确认自身位置及 `src` 不变；嵌套覆盖、更改父级、恢复当前目录后深层覆盖仍保留。
2. AE3：选取与继承值相同的规则，再改全局，确认该目录已独立固定。
3. AE4：在 `a/b/c` 菜单选择每一级设置和恢复，确认目标/来源明确，选择和展开不变。
4. AE5：同 ID 的主项目/两个 Worktree、大小写不同的 WSL 根、不同 SSH 主机/远程根隔离；保存中切项目后旧结果不影响新菜单。
5. AE6：侧栏和嵌入面板交错操作，重开、重启、偏好导出/恢复后规则一致；失败提示可重试。
6. 真实文件行的 Ctrl/Command 多选、F2/Delete/剪贴板、目录/终端拖拽和慢 Git 首屏照常；箭头及弹层操作不触发这些动作，拖放到箭头不移动文件。
7. 中英文、浅/深色、窄面板、左右停靠/合并/独立面板、鼠标/触摸/键盘均检查；Esc 关闭（含保存中）恢复焦点，长路径与 Git 标记不重叠。SSH 文件写保护仍然生效。

## 使用后观察与恢复

观察窗口为首次设置、双面板交错使用、重新打开/重启和一次备份恢复；负责人为用户。
健康信号：作用目录正确、规则及箭头一致、另一面板同步、重启保留、无额外目录/Git 请求和文件操作。
失败信号：`files.sort.saveFailed`、`invalid_file_tree_sort_target`、`file_tree_sort_settings_unavailable`、规则丢失/跨根混用或快捷键误触。
出现失败时先停止相关目录排序操作并保留设置备份；可对目标目录恢复继承，必要时使用功能前应用包。不要清空整个偏好表或修改认证配置；恢复动作与编译/安装由用户决定。
