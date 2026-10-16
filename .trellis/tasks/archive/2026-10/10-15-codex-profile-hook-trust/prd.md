# Codex profile Hook 信任状态持久化与检测

## 目标与证据

修复同名 Codex 供应商 profile 再生成丢失已保存 Hook 决定，以及侧边栏只读全局配置导致与真实运行状态不一致。关联已完成任务 `10-08-codex-provider-config-propagation`。

只读排查：当前 Codex 0.162.1 的 `--profile` 将 `<name>.config.toml` 叠加在全局配置上；9 条托管 Hook 中 8 条全局哈希匹配，提问 Hook 的 matcher 从 `request_user_input` 更新为 `^request_user_input(_async)?$`。两个供应商文件已有匹配的新确认，全局仍旧。scope 生成入口直接覆盖同名 profile；Hook 状态入口没有 profile 参数。

## 范围与验收

- [x] 同名应用生成 profile 重建时只保留该文件已有的 `hooks.state` 用户决定；供应商/公共配置不得注入信任，不复制其他 profile 或修改全局确认。
- [x] 缺失、过期、禁用决定保持语义；损坏既有文件不能静默覆盖。写入失败保留原文件；检测到并发变化时不得伪装为成功。
- [x] 侧边栏和设置页使用当前本机 Codex 终端实际 `--profile`，检查全局加该 profile 的有效特性和信任；显示检查范围和待审核原因。无选中本机 Codex 时仍检查全局。
- [x] 安装/卸载返回、目录/终端切换、手工 profile、恢复命令及确认后的只读刷新使用一致上下文，异步旧结果不能覆盖新上下文。
- [x] 状态查询不写配置；安装不制造信任。WSL/SSH 不冒用 Windows profile；不改变项目扩展快照生命周期，新独立 profile/新 Hook 定义仍需 Codex 审核。
- [x] 定向 Rust/Node 回归、类型/严格架构检查、桌面/Web 生产构建通过；先提交再缓存构建 1.4.3 NSIS，记录来源和哈希，不安装、不推送。
- [x] 用户安装后确认并重建同一供应商终端验收（2026-10-15 用户明确反馈“修复了”）。

基线 `master a9ea11c9`，工作区干净，与已记录 origin/master 同步。本轮不 fetch/merge/push，不启动应用或修改真实配置。

## 用户追加验收

- 同名 profile 保留已保存的目录信任与拒绝决定，不从供应商自动授权。
- 待审核 Hook 点击恢复安装/重装，绿色点击仍打开设置。
- 1.4.3，仅 NSIS，提交后构建，不安装、不推送；fast/状态栏不改。
