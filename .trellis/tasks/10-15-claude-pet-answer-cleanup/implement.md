# 实施与静态核查清单

## 授权及执行方式

用户已审阅根因与修复方向并明确要求执行。当前宿主没有 GitNexus 或实现子代理接口；独立 advisor 未得到有效结果，采用本会话定向实现和人工静态复核。保留当前未跟踪的旧 Pi 方案记录，不提交或清理 rpiv。

## 步骤

1. 在独立完成模块中先写回归用例：Attention 独立安装、两种安装顺序、幂等、旧配置升级、错误 matcher、两个卸载方向、最终清理和外部命令保留。
2. 补成功/失败完成回调、Windows/WSL 命令及问题/Agent/Task 工具 ID 保留覆盖。
3. 增加专用后端消费器，覆盖 Claude-only 接纳、错会话/错工具 ID、开始事件不清理、已提交待确认不撤销；通过 broker 公开内存入口验证，不启动端口。
4. 实现 Attention 专用完成注册、完整性检查及定向清理；接入鉴权/校验/去重后的内部消费，返回后不得进入 UI/通知 sink。保持 broker 生产代码不变。
5. 更新现有脚本契约，锁住 Attention 独立完成和卸载隔离；更新 CHANGELOG.md、docs/功能清单.md 与相关 Hook 契约。
6. 静态核查每条变更、导入与可见性、模块路径、代码行数、UTF-8 / 行尾、Git 空白检查及未跟踪文件；检查 Pi/rpiv 与其他 fork 功能未改。
7. 汇报源码完成与未执行的验证，提供用户本地命令；未经另行请求不推送。

## 验证约束

只阅读和分析源码。回归用例编写但不运行，不用“静态复算断言”代替禁止执行的测试，不执行 cargo check/test、npm build/test、应用或服务。静态语法检查不执行被检查文件。

用户后续可执行：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml claude_completion
cargo test --manifest-path src-tauri/Cargo.toml desktop_pet_e_completion
node --test scripts/desktopPetEAgentBridge.test.mjs
npm run test:pet-e:contracts
```

真实验收：仅安装 Claude 问答/提醒模块，终端完成 AskUserQuestion 后宠物对应待处理项消失；关闭子任务分屏或卸载 subagent 后仍成立。宠物提交尚未确认时不得被完成回调中断。仍有残留时需确认回调是否实际送达和是否具备对应工具 ID，不能以无条件清空补偿。
