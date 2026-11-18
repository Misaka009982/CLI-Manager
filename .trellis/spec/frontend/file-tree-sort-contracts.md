# 文件树排序契约

## 范围

桌面 FileExplorerSidebar 的侧栏与嵌入面板、shared/lib/fileTreeSort.ts 和 shared/preferences/fileTreeSortPreference.ts。独立 apps/web 不在此契约内。

## 排序

- Settings.fileTreeSort 是全局默认，Settings.fileTreeSortOverrides 是目录覆盖表；两者共同构成唯一持久化真值。规则字段为 key（name/date）与 direction（ascending/descending）。默认名称升序；切换到日期默认降序。重复选择当前维度不覆盖用户方向。
- 覆盖作用域为项目 ID、环境类型与 fileContentRoot(project) 的 JSON 元组，目录键为相对路径；主项目和同 ID 的 Worktree 按实际根隔离，SSH 主机/远程根不混用。本地 Windows/普通 UNC 忽略大小写，WSL/POSIX/SSH 保留大小写；共享层不导入 features。
- 当前目录显式规则优先于最近显式祖先，最后回落全局。目录设置只在进入其 children 时生效，不决定自身在父级的位置，也不影响同级目录内部。
- 主动选择与继承值相同的规则仍建立覆盖；父级/全局变化保留更深层覆盖。“恢复继承”只删除当前目录项，空作用域可清理，未加载树中的其他记录不自动删除；重命名/移动不追踪旧目录身份。
- 每层目录先于文件，升降序不能反转目录优先级。名称采用忽略大小写的自然排序；日期采用 modifiedMs。
- 仅有限且非负的数值时间有效，0 是有效时间；缺失、NaN、无穷或负值均在同类型内后置。同时间按名称稳定排序。
- 排序为原始树的只读投影；所有已加载 children 递归采用当前有效规则，未加载目录保持按需读取。sortFileTreeEntries 保留双参数行为，仅增加可选目录解析入口。搜索结果、选择、路径、编辑器缓冲区与展开状态不被排序修改，不新增目录/Git 请求。

## 更新与错误

- 菜单提交单项变更，不提交来自旧渲染的完整设置快照。
- 全局、目录 set 和 reset 在 fileTreeSortPreference.ts 共用一个串行更新器；目录操作先捕获作用域、路径和变更意图，每次出队时读取当前 Settings，再合并并持久化，防止连续选择相互覆盖。已有相同覆盖可省略写入，但首次同值固定不能跳过。
- 队列恢复仅保证后续任务继续执行，当前保存失败必须传播给调用者；菜单显示失败且允许重试，不宣称保存成功。
- 通用设置入口对 fileTreeSort 和 fileTreeSortOverrides 规范化，加载和备份恢复均过滤非法值；覆盖项不以默认值修补损坏记录，否则会错误截断继承。相对路径拒绝绝对/越界路径和危险对象键，合法记录重建为安全对象；两个键均属于 preferences 备份分类。
- 非 Tauri、偏好未加载或作用域缺失时不能写盘；SSH 只读只禁止文件修改，不禁止本地排序偏好。
- 保存期间禁用重复操作并显示状态；方向按钮与日期方向文案同步，两个单选分组和键盘导航可访问。目录箭头保持可聚焦但禁止保存中再次打开，Esc 和关闭后的焦点恢复不受破坏；旧菜单卸载后的回执不更新新 UI。

## 文件夹菜单与事件

- 文件夹箭头与展开/选择区域并列，不嵌套在原行按钮内；文件行无排序按钮。箭头显示有效方向，提示及菜单区分独立、最近祖先和全局默认，覆盖中英文。
- 紧凑链保持现有显示，在菜单内提供链中每一级作用目录，默认末级；目标切换不写盘，选择规则或 reset 成功后关闭，失败保持菜单并可重试。
- 项目/实际根/目录链身份变化重建排序会话并关闭旧菜单。旧保存仍只作用于捕获目标，不清理其他目录覆盖。
- FolderTreeSortMenu 的事件边界拦截指针、点击、双击、右键、键盘及 Portal 冒泡，不触发行/根文件快捷键。默认聚焦与按钮键盘激活保留，仅对箭头上的 dragover/drop 阻止默认行为，避免根目录移动或浏览器打开拖入文件。
- 按钮常驻并预留宽度，文件名可收缩，Git 标记不被遮挡；行上下文菜单打开时仍保持高亮和忽略态提亮。

## 回归

- scripts/fileTreeSort.test.mjs 保留四种排序、目录优先、异常/相同时间、时间 0、递归不可变、默认方向、旧双参数/更新器兼容及搜索分流。
- scripts/folderTreeSort.test.mjs 覆盖父级继承、嵌套覆盖、同值固定、set/reset 交错、最近祖先边界、作用域捕获、失败后重试与非法记录；scripts/folderTreeSortPreference.test.mjs 从实际源码取 Settings 默认/load/update 与偏好模块，仅隔离 Tauri/KV，检查路径身份、备份恢复和真实共用队列。
- scripts/folderTreeSortUi.test.mjs 沿用 TypeScript AST/VM 检查真实处理器和行结构，不能当作 DOM 通过。scripts/folderTreeSort.browser.mjs + scripts/fixtures/folderTreeSort.tsx 复用已有 PLAYWRIGHT_MODULE/Edge，取实际 FileNode/FileTreeRows、Portal 菜单及 Settings 接线组成真实 DOM 夹具；只隔离文件服务/平台传输，不重新实现排序逻辑，不自动下载或构建应用。
- 行布局、触摸、键盘焦点、慢存储、重启恢复、本地/WSL/SSH 与实际文件拖拽仍需用户执行回归及实机验收；不能把用例存在、处理器隔离或静态检查当作运行通过。
