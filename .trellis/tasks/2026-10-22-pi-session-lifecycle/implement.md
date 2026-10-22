# 实施计划

## 步骤

1. 先补生命周期回归：错误后 shutdown(new) → 新工厂 → SessionStart → 新任务；对 resume/fork/reload 复用同一组场景。保留旧 handler 复用场景，并覆盖旧回调与子实例隔离。
2. 修复 fork 模板所有权交接、有效回调守卫和异步对话框作用域；等待序号保持实例内单调；模板与 Rust 常量统一 v11。
3. 新增独立的 Pi SessionStart 复位 helper，最小接入终端和 daemon；只复位 Pi，不改变其他 CLI 的事件表，不伪造 UserPromptSubmit/Stop/Interrupt。
4. 补全宠物E空闲投影和历史清理；验证后台旧状态与重绘不会恢复错误，真实待答仍优先。
5. 更新当前 V1.4.4 CHANGELOG、功能清单及外挂接入说明；静态检查差异、导入、字段、UTF-8、版本及测试夹具契约；记录未运行项。

## 回归用例的归属

- `scripts/piHookLifecycle.test.mjs`：扩展重建和复用、连续切换、同 ID reload、旧回调、父子隔离、模块开关、只读等待恢复。
- 新 Pi 会话 helper 用例：来源/事件/身份校验、权威空闲及后续状态替换、不混入普通 CLI 语义。
- `scripts/desktopPetEState.test.mjs`：failed → none → running，前台/后台空闲清历史、TUI 重绘、旧后台状态与真实待答；相关 resolver 不再过度 mock。
- 新 Rust helper 单元用例及必要接纳门断言：合法 Pi 复位、非 Pi/SSH/缺失身份不复位；新代际允许、旧终态拒绝。
- `scripts/piDesktopPetHook.test.mjs`：v11 一致、生产者与生命周期守卫契约。

## 静态核查清单

- 不执行编译、测试、安装、应用启动或外部脚本；不提交、推送。
- `git diff --check`、逐段差异审阅、相对导入目标存在、Rust 模块可见性与构造器、UTF-8 可解码、无冲突标记。
- 手写代码不超过 2000 行，不重排无关内容；避免新增依赖/配置字段。
- 上游共有文件只保留少量薄接点；旧任务、其他 worktree 和用户已安装文件不变。

## 用户运行验收（本轮不执行）

更新应用及托管 Hook 后重载 Pi；制造一次模型失败，执行 `/new`：旧错误应清除并进入空闲；发送新问题后应出现运行状态，随后完成/失败正常更新。继续检查 `/resume`、`/fork`、连续 `/new`、后台/分屏、本机/WSL，以及问答和只读等待。旧版本托管副本不会因仓库文件编辑自动升级。
