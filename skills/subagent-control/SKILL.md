---
name: subagent-control
description: 使用已保存的综合投入策略派发 Codex 子代理，或打开强度控制面板、调整 10%–100% 档位。适用于用户要求使用 Subagent Control，或需要按此插件策略分工的子代理任务。
---

# Subagent Control

通过本插件 MCP 工具读取真实设置，不从历史对话推断当前档位。强度表示模型、推理、复核的综合投入，不表示准确率或与 Astra 的质量比例。

## 面板与设置

- 用户要浮窗、桌面小窗或额度条：调用 `open_floating_window`。这是半透明、默认置顶的 Windows 额度条，显示拖动栏、Codex 实际剩余额度和设置按钮，每分钟刷新。设置按钮打开原生设置窗，可分别保存背景不透明度、置顶和子代理策略。右键也可打开设置、刷新、切换置顶或关闭。失败时说明真实原因；网页模式不等同于桌面置顶浮窗。
- 用户要 UI：调用 `open_control_panel`，然后用 Codex `open_in_codex` 的 browser 目标打开返回的完整 URL。若没有该 UI 工具，返回可点击的本地 URL。不要用 shell 打开浏览器。
- 用户明确指定强度：先 `get_policy` 取得 revision，再调用 `set_strength`，保留已有 costPreference，除非用户要求改变。只接受 10–100、每 5 一档；其他数值请用户选择相邻档位。
- 用户要优先使用 DeepSeek V4.1 Flash：设置 costPreference="deepseek_first"，保留当前强度。官方模型 ID 是 deepseek-flash；DSH 是调用通道名，不是模型名称。浮窗高级选项也可选择此偏好。
- 单纯讨论或预览方案时用 `preview_policy`；不要保存未被用户选择的设置。
- 409 或 revision 冲突：重新读取，告知设置已变化，不默默覆盖他人的更改。
- 工具返回“插件已停用”时：不再按本插件路由或派发，也不要重试或改用其它模型替代；告知用户可在设置面板开启。

## 派发工作

1. 用 `get_policy` 读取本次设置。对每个独立子任务调用 `route_task`，传真实类别、1–5 难度、visualImpact、designSpecified、executionSpecified 与 work/final_review 阶段。仅在任务范围、规格和验收清楚且无需架构决策时标 executionSpecified=true。没有可用的 `dsh_delegate` 时传 dshAvailable=false。
2. 视觉方向、排版、配色、字体、动效、三维美术、图像提示词与成图筛选都属于 visual_design。任何视觉输出传 visualImpact=true。只有 Astra 已给出足够明确的设计规格，工程实现才可标 designSpecified=true；存在未决视觉选择时标 false。
3. 安全、隐私、数据迁移用 security_privacy_migration。不要为省额度把这些任务标为 mechanical。全部视觉设计、未明确规范的视觉实现、最终视觉验收和上述高风险任务固定 gpt-6-astra/max。
4. native_subagent 使用返回的准确 model 与 reasoning 派发原生子代理。使用自包含任务书与 fork_turns="none"，避免继承整个主线程，也便于指定模型。派发前用 `validate_assignment` 核对同一组任务参数、model、reasoning。若设置刚变化，重新读取路由再派发。
5. dsh_delegate 使用 model="deepseek-flash"、reasoning_effort="max"、自包含任务和存在的绝对 cwd。DeepSeek 的最低及固定推理投入均为 max，不随强度降档。实际调用该工具并等待结果，不能把 route_task/validate_assignment 的计算结果冒充为模型执行。检查 execution.effectiveModel 与 execution.reasoning 是否匹配；缺失确认、取消或错误结果不得当作成功。只委派低风险、规格明确的任务。“DeepSeek 优先”在 10–85% 档支持机械执行、明确规格的实现及资料整理；复核交指定的 Sol/Astra。不要将架构、安全、设计决定或最终判断下放。
6. 限制总并行数为 policy.maxParallel；maxDelegations 是可选派发上限，不要求用满。只并行独立工作，同一文件只设一位写入者。短任务可直接完成；涉及锁定类别时仍须使用 Astra/max。
7. 普通任务一次修复后仍未通过、发生架构冲突或关键不确定性时，传 escalated=true 重新 route_task 并核验，直接升级 Astra/max。必要升级不因预算比例被拒绝。锁定任务若 Astra/max 不可用，应报告阻塞，禁止降级或伪造验收。
8. 取得实际 diff、相关测试和未解决问题，按 decision.reviewPlan 完成复核。decision.finalReviewer 不为空时，使用指定模型/推理执行最终验收。视觉验收必须查看实际渲染、相关尺寸和交互状态，不能只读代码或摘要。存在独立复核要求时，审查者不同时承担实现。

## 生效边界

设置持久保存在用户 Codex 目录的 subagent-control/settings.json。它控制此插件工作流中的后续派发，不修改全局主模型、不切换已有代理，也不保证主会话、外部插件和所有原生调用会被拦截。路由工具计算并校验策略，实际执行依赖可用的原生协作工具与已有 DSH 插件。不要宣称已完成模型切换或达到某个质量百分比，除非有实际证据。

遵循当前任务权限、技能要求和工具可用性。本插件不扩大执行权限，也不授权发送消息、发布、部署或修改无关设置。
