# Bug Analysis: 布局锁定的主题与菜单边界

## 1. Root Cause Category
- D — Test Coverage Gap：初版仅验证组件输出和锁守卫，没有执行真实嵌套 Radix/DnD 菜单及 CSS 级联。
- E — Implicit Assumption：将应用通用按钮样式用于独立主题的终端；假设嵌套菜单仅靠 defaultPrevented 就能稳定区分事件所有者。
- 主题差异由浏览器计算样式测试复现；用户报告的锁后菜单缺失在隔离夹具未复现，因此事件归属是经源码分析加固的边界，不能声称已复现全部桌面触发条件。

## 2. Why Initial Verification Missed It
初版 VM 测试隔离了 DOM/事件和 CSS，不能证明菜单的嵌套交互与终端主题显示正确。

## 3. Prevention Mechanisms
| Priority | Mechanism | Action | Status |
| --- | --- | --- | --- |
| P0 | Event ownership | 两类标签停止右键冒泡，空白菜单排除标签目标 | Done |
| P0 | Shared styling | 锁按钮使用终端标签控件样式；toast 保留应用默认通知样式 | Done |
| P0 | Browser tests | 保留生产标签/DnD/Radix/CSS，仅替换桌面副作用 | Done |

## 4. Systematic Expansion
覆盖顶层标签、Pane 标签和空白区；中英文；从菜单锁定后再次右键；明暗应用与终端主题的四种组合；锁定提示及解锁动作。

## 5. Knowledge Capture
- [x] 更新 frontend/state-management.md 的事件边界、无图标菜单与主题契约。
- [x] 更新 V1.4.4 CHANGELOG 和功能清单。
- [x] 更新任务验证记录与桌面复核步骤。
