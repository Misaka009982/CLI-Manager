# 实施与验证计划

## 顺序

1. 完成排序源码审查，记录根因、受影响入口与测试缺口。
2. 补齐定向回归用例，再修补排序比较器、专用偏好队列和菜单反馈；不运行用例。
3. 更新 V1.4.2 CHANGELOG.md、docs/功能清单.md 及排序契约。
4. 检查 UTF-8/CRLF、导入路径、翻译键对称、Git 差异与新增文件，单独提交排序功能。
5. 核实并拉取 origin/master 与上游 V1.4.2 标签，记录提交规模、改动路径和 fork 交集。
6. 从排序提交新建 integrate/v1.4.2-desktop-pet-e；使用双父 merge，逐项解决冲突。
7. 核对版本号、发布资源、宠物E/窗口状态/排序接线、文件保留清单与未合并索引，形成合并提交。
8. 汇报两个提交、最终工作区状态、静态证据与用户待运行验证。暂不推送。

## 提交边界

- 提交一：feat(files): add persistent file tree sorting。包含排序实现、回归用例、相关产品记录和本轮任务记录。
- 提交二：merge: sync upstream V1.4.2 keeping fork customizations。保留两个父提交，包含必要的兼容冲突解决与最终任务证据。
- 若远端 fork 在本地基线之外有新提交，先报告分叉/领先情况，不覆盖它们。

## 验证策略

本轮明确采用静态分析，不运行应用、编译、测试或安装依赖。回归用例作为待执行证据，不伪造先红后绿结果。语法检查仅允许不执行模块的检查模式；不会用正则括号计数代替 TypeScript 类型检查。

需检查：

- 名称自然排序与目录优先；日期方向、未知时间与同时间稳定排序。
- 递归不修改源树；搜索分流不变；刷新后仍按当前偏好投影。
- 队列每次执行时读最新设置，失败向调用者传播且不毒化后续写入。
- 菜单忙碌、错误提示、键盘导航和方向图标；中英文键一致。
- settingsStore 默认、加载迁移与备份策略一致；不新增 shared 到 features 的依赖。
- 合并无冲突标记；独占文件对象标识及共享接入点逐项复核。

## 用户本地验证（本轮不执行）

```powershell
node --test scripts/fileTreeSort.test.mjs
npm run build
npm run test:pet-e:contracts
npm run check:architecture
cargo test --manifest-path src-tauri/Cargo.toml
```

人工验证：本地/WSL/SSH 文件树各切换四种排序，连续选择与保存失败提示，重启后偏好恢复，两个显示宿主与深浅主题、搜索顺序、展开与拖拽不回归。
