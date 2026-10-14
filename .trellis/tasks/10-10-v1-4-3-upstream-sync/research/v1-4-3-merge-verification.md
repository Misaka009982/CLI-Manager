# V1.4.3 合并核查

## 来源与授权

- fork 起点：443822a1d4cde86d888c169a94ffadffb82384f7。
- 上游目标：c07e69eed3842a69ab5e39d10b166bb3a84f6610；V1.4.3 标签对象 b93fc60baa8a114c38145744d765f5ff80d276f1。
- 共同祖先：917437d1546c75997f6120339e948305b93907ad。
- 上游范围：9 个提交、58 个文件，未删除或重命名文件。
- 用户确认在既有 worktree 中同步、保留 fork 功能、本地提交且暂不推送。随后确认先收尾此合并，再独立实现问答兼容；本提交不包含 rpiv 问答适配。
- 当前会话直接执行。未配置外部实现引擎；Trellis 因沙箱没有会话身份而采用脚本支持的降级模式，任务状态已进入 in_progress，不伪造会话指针。

## 冲突处理

1. CHANGELOG.md：保留 fork 的文件树排序小节，同时保留上游补入的 Codex 状态栏配置优先级修复。
2. features/hooks/settings/pi.rs：保留 fork 的 include_str! 生成器，文件最终与 fork 起点完全一致；上游唯一行为变化迁入实际外部模板，而不是丢弃。
3. pi_extension_template.ts：postHook 新增 wslDistroName: nonEmpty(process.env.WSL_DISTRO_NAME)，没有增加默认发行版、修改请求超时或改变交互桥接。
4. 外部模板头与 Rust PI_EXTENSION_VERSION 同步升为 8；原有受管升级、无主文件保护和未来版本不降级逻辑保留。

## 测试适配与证据边界

- scripts/wslHookIdentity.test.mjs：上游假定模板内联在 Rust raw string，fork 改为沿 include_str! 实际路径读取源文件并展开占位符。仅桩掉 Pi 提供的 schema/TUI、随机 ID 与心跳边界，按顺序等待异步生命周期回调。保留 Ubuntu、带空白 Debian、无发行版和空白发行版的 Pi/OpenCode 共 8 个用例及真实 payload 断言。
- scripts/piDesktopPetHook.test.mjs：模板版本与 Rust 常量动态比对，要求至少为包含本次升级的 8；新增 WSL 字段存在性保护。
- 已阅读安装/卸载、原地升级、不降级 Rust 用例，继续沿用 PI_EXTENSION_VERSION + 1 的未来版本测试。
- 按约定未执行任何测试、编译、依赖安装或应用启动。没有红绿测试结果；语法检查不替代生命周期运行、WSL interop 或 GUI 验收。
- 专用多代理审查不可用（当前没有对应子代理调用工具），改为定向手工差异审查，未冒充独立审查结论。本轮自己的生产代码仅一处上游字段移植和版本常量更新，不做无关重构或简化。

## 已执行的静态检查

- node --check scripts/wslHookIdentity.test.mjs：通过。
- node --check scripts/piDesktopPetHook.test.mjs：通过。
- git diff --cached --check：通过。
- git diff --name-only --diff-filter=U：空；两处冲突均已从索引解除。
- fork-baseline.json 中 98 条路径逐项比对 Git 对象和文件模式：92 条不变，其中 82 条为产品/契约路径。
- 6 条声明内变化：CHANGELOG.md、docs/功能清单.md、package.json、scripts/piDesktopPetHook.test.mjs、features/hooks/settings/mod.rs、pi_extension_template.ts。
- 上游 53 条非重叠且无需适配的路径与目标提交完全一致。其余 5 条逐项审查：版本记录、功能清单、package.json、Pi 生成器及 WSL 测试。
- pet-e 的 19 个跟踪文件、window_state.rs、alpha-release.yml、fileTreeSort.ts、fileTreeSortPreference.ts 与 verify-pet-e-package.mjs 均保持。
- package.json、package-lock.json 顶层及根包、tauri.conf.json、Cargo.toml、Cargo.lock 的 cli-manager 主包版本均为 1.4.3。
- 手工修改的 7 个产品/测试文本均可严格 UTF-8 解码且无孤立 LF；没有整文件行尾翻转。
- docs/功能清单.md 第 158 行存在单独的 =======，已与上游同一行核对，这是既有文本，不是本轮残留合并状态；按最小变更原则不清理。
- 规范复核：继续使用既有外部模板及版本升级约定，本次没有新的生产协议设计；模板测试的读取约束记录在此，不重写无关领域规范。

## 发布后人工验证

- Codex 必须支持 --no-daemon；重新创建本机/WSL/SSH 终端后，验证多会话 Hook 归属、提问通知与精确统计。
- 旧 PTY/daemon 不会热更新端口、令牌或 WSLENV，需要在新版应用下重建；通过 Hook 设置升级/必要时重新安装受管扩展，再重新加载 Pi/OpenCode。
- 复验宠物E 双端问答和权限清除、窗口几何恢复及文件树排序持久化。
- 用户执行 npm run build、npm run test:pet-e:contracts、node --test scripts/wslHookIdentity.test.mjs scripts/codexHookIsolation.test.mjs scripts/agentCapabilities.test.mjs scripts/fileTreeSort.test.mjs，以及 cargo test --manifest-path src-tauri/Cargo.toml。
