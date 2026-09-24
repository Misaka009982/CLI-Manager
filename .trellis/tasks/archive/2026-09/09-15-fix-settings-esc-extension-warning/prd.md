# PRD: 修复设置页 ESC 退出失效与启动扩展警告误报

## Goal

修复两个用户体验问题：
1. 设置-MCP与Skill管理界面无法用 ESC 键退出
2. 未配置项目扩展策略时启动终端仍弹出警告"部分项目扩展策略未能应用;未应用部分继续使用CLI的全局状态。"

用户期望：静默处理，无配置时不弹警告。

## Background

### Bug 1: ESC 键失效
- **位置**: `src/features/settings/api/SettingsModal.tsx:247-253`
- **根因**: `hasOverlayAboveSettings()` 函数逻辑错误，即使只有设置页打开也会误判"有上层弹框"，导致 ESC 事件处理器提前退出
- **当前逻辑**: 遍历所有 `[role="dialog"]`，只要找到任何不等于 `settingsDialog` 的元素就返回 true
- **问题**: `dialogRef.current` 可能未正确指向实际 dialog DOM，或设置页嵌套结构导致永远命中"其他 dialog"

### Bug 2: 启动警告误报
- **后端**: `src-tauri/src/features/extensions/project_policy.rs:536-542` 的 `resolve_policy` 在检测到 `invalid_ids` 非空时返回 `application_status = "error"`
- **前端**: `src/features/terminal/store/terminalStore.ts` 在 4 处启动路径检查 `extensionStatus === "error" || "globalOnly"` 后弹 toast
  - L600-602: `createSession`
  - L392-394: 远程 handoff 会话恢复
  - L1036-1038: 分屏创建
  - L1716-1718: 批量会话恢复
- **触发条件**: 项目之前保存过 Custom 策略，后来资源被卸载，遗留 invalid IDs 即使在 Inherit 模式下也会触发 error

## What I Already Know (from codebase inspection)

### Extension Policy Modes (Confirmed)
- **Enum**: `ExtensionPolicyMode { Inherit, Custom }` (L63-66)
- **Inherit**: 未主动配置项目策略，继承上层（项目→全局，worktree→项目→全局）
- **Custom**: 用户在项目/worktree 明确选择了 MCP/Skill ID 列表

### Policy Resolution Logic (L443-564)
1. 优先读取当前 scope（project/worktree）的 Custom 策略
2. 若无或为 Inherit，向上查找：worktree→project→global
3. `inherited_from` 标记最终生效层级：`"project"`/`"worktree"`/`"global"`
4. `effective_ids` 是策略解析后应生效的 ID 列表
5. `invalid_ids` = `effective_ids - available_ids`（已配置但资源不存在的 IDs）

### Application Status Logic (L527-543)
```rust
capability_status = if cli == Grok { "globalOnly" } else { "supported" }
application_status = "applied"  // 默认

if capability_status == "globalOnly" {
    application_status = "globalOnly"  // Grok 不支持项目级
} else if !invalid_ids.is_empty() {
    application_status = "error"  // 有无效 ID
}

applied_ids = if status == "applied" { effective_ids } else { global_ids }
```

**问题根因**：`invalid_ids` 检查不区分 mode，即使 `mode == Inherit` 且 `inherited_from == "global"`（未主动配置），只要全局配置有 invalid IDs，仍返回 `"error"`。

### Frontend Toast Trigger Points (4 处)
- `terminalStore.ts:392-394`: 远程 handoff 会话恢复
- `terminalStore.ts:600-602`: `createSession`
- `terminalStore.ts:1036-1038`: 分屏创建
- `terminalStore.ts:1716-1718`: 批量会话恢复

条件：`extensionStatus === "error" || extensionStatus === "globalOnly"`

### User Configuration Detection
- **无配置**：数据库 `extension_scope_policies` 表中不存在该 project_id + scope_id + cli + kind 的记录
- **Inherit 模式**：有记录但 `mode = "inherit"`，或无记录（L291 注释：缺失行代表 inherit）
- **Custom 模式**：有记录且 `mode = "custom"`，`selected_ids_json` 非空

## Requirements

### R1: ESC 键正常工作
- **R1.1**: 设置页无其他弹框时，按 ESC 键能关闭设置页
- **R1.2**: 设置页之上有其他弹框（供应商维护、SSH 主机维护、插件安装等）时，ESC 仅关闭最上层弹框，不关闭设置页
- **实现要点**: 修复 `hasOverlayAboveSettings()` 函数逻辑，正确检测是否存在上层弹框

### R2: 静默启动（无误报警告）
- **R2.1**: 场景 A（项目无策略记录，完全继承全局）：即使全局有 invalid IDs，启动终端不弹警告
- **R2.2**: 场景 B（项目有策略记录但 mode=Inherit）：即使全局有 invalid IDs，启动终端不弹警告
- **R2.3**: 场景 C（项目有策略记录且 mode=Custom，selected_ids 包含 invalid IDs）：启动终端**弹警告**
- **R2.4**: Grok 返回 `"globalOnly"` 时不弹警告（这是产品限制，不是配置错误）
- **实现要点**: 
  - 后端：只在 `mode == Custom` 时检查 invalid_ids
  - 前端：只对 `"error"` 弹 toast，移除 `"globalOnly"` 判断

## Decisions Made

### D1: 警告语义边界（已确认）
- 场景 A（无策略记录）：**静默**
- 场景 B（显式 Inherit）：**静默**（与场景 A 语义一致，都是"不管项目级配置"）
- 场景 C（Custom 含 invalid IDs）：**警告**（真正的配置错误）

### D2: 后端修复方案（已确认）
- **方案选择**: 方案 1（只在 `mode == Custom` 时检查 invalid_ids）
- **理由**: 最简单直接，完美匹配需求，改动最小
- **实现**: 修改 `project_policy.rs:537` 的条件判断

### D3: globalOnly 处理（已确认）
- **决策**: 移除 globalOnly 警告
- **理由**: 这是 Grok 的产品限制，不是用户配置错误，不应每次启动弹 toast
- **实现**: 前端 4 处改成 `if (extensionStatus === "error")`

## Acceptance Criteria

### Bug 1: ESC 键
- [ ] AC1.1: 设置-MCP与Skill管理页面打开时，按 ESC 能关闭设置页
- [ ] AC1.2: 设置页之上打开插件安装弹框，按 ESC 只关闭插件弹框，不关闭设置页

### Bug 2: 启动警告
- [ ] AC2.1: 全新项目（无扩展策略记录）启动终端，不弹扩展警告
- [ ] AC2.2: 项目策略 mode=Inherit 启动终端，不弹扩展警告（即使全局有 invalid IDs）
- [ ] AC2.3: 项目策略 mode=Custom 且所有选中 IDs 有效，启动终端不弹扩展警告
- [ ] AC2.4: 项目策略 mode=Custom 且部分选中 IDs invalid，启动终端**弹警告**
- [ ] AC2.5: Grok CLI 启动终端（返回 globalOnly），不弹警告

### 回归验证
- [ ] AC3.1: 分屏创建会话时警告逻辑正确（4 处触发点统一修改）
- [ ] AC3.2: 远程 handoff 会话恢复时警告逻辑正确
- [ ] AC3.3: 批量会话恢复时警告逻辑正确

## Out of Scope

- 不修改扩展策略的数据模型
- 不在设置界面增加"清理无效策略"按钮
- 不改变 invalid_ids 的计算逻辑（只改检查时机）
- 不为 globalOnly 增加静态提示（可作为未来改进）

## Technical Notes

### Bug 1 涉及文件
- `src/features/settings/api/SettingsModal.tsx:247-253, 308`

### Bug 2 涉及文件
- 后端: `src-tauri/src/features/extensions/project_policy.rs:537`
- 前端: `src/features/terminal/store/terminalStore.ts:392, 600, 1036, 1716`

### 依赖关系
- Bug 1 和 Bug 2 完全独立，可并行修复
- 前端 4 处 toast 触发点必须统一修改，避免遗漏
