# 有bug先别用


# Subagent Control · 子代理强度控制

个人 Codex 插件，包含本地控制面板、独立 Windows 桌面浮窗、MCP 策略工具和派发技能。Node.js 20+；HTTP 与 MCP 模式保持零第三方运行时依赖，桌面浮窗模式额外需要 Electron（44.4.3），该依赖不进入前两种模式。

## 功能

- 10%–100%，步长 5，共 19 档；默认 70%。强度表示模型、推理与复核投入，不是质量保证。
- 三种偏好：节省 Codex 额度、节省 API 费用，以及 DeepSeek 优先。项目将 `deepseek-flash` 显示为 DeepSeek V4.1 Flash；DSH 是其委派通道，具体模型可用性取决于部署配置。
- DeepSeek 固定使用 `max` 推理，强度不会降低其推理档位。调用桥接通过每次调用独立的模型选择服务请求锁定模型，不修改 DSH 全局设置；必须收到模型确认才能视为校验成功。2026-09-24 的一次真实调用未取得该确认，当前仍需检查此链路。
- 每个档位都将视觉设计、安全/隐私/数据迁移与最终视觉验收锁为 `gpt-6-astra` / `max`。
- 紧凑策略摘要展示当前模型分工，高级选项可展开查看完整明细。
- 设置持久化、修订号防覆盖、原子写入；保存后下一次派发生效。
- 插件总开关：停用后不路由、不校验、不读额度、不写审计记录，只保留设置面板本身用于重新启用。
- 本地 HTTP 仅监听 127.0.0.1；随机端口与会话令牌；不加载 CDN、不读取模型密钥。
- 独立 Windows 桌面浮窗（Electron 44.4.3）：280×112、半透明、默认置顶，显示拖动栏、Codex 剩余额度和设置入口。蓝色强调、中性灰、细分隔线、小圆角与系统字体统一应用于浮窗和设置面板。
- 额度通过已登录的 Codex CLI 官方 `account/rateLimits/read` 接口读取，每分钟自动更新，Ctrl+R 手动更新；不启动模型任务。仅显示实际返回的额度周期，缺失不表示 0% 或 100%。失败时标示旧数据；无有效数据时显示“未获取”。
- 点击浮窗右上角设置按钮打开独立原生设置面板（420×640）；可分别保存背景不透明度（50–100%，步长5）、始终置顶，以及原有强度和 DeepSeek 偏好。只改变背景透明度，文字保持不透明。

## 使用

安装或更新插件后开启新任务，说“打开子代理浮窗”（对应 MCP 工具 `open_floating_window`），即可打开半透明 Codex 额度条。说“打开强度控制面板”可选择档位并保存，随后说“按 Subagent Control 当前策略完成这个任务”。也可直接要求“把综合投入设为 75%”。

`open_control_panel` 在浏览器中打开策略设置面板，适合放在 Codex 浏览器侧栏；不透明度与置顶仅在桌面原生设置窗显示。浮窗设置保存在 `subagent-control/window-settings.json`；策略仍保存在 `settings.json`，两组设置分别保存、分别防止旧版本覆盖。桌面浮窗会自动同步保存后的外观设置，首帧从服务端注入已保存的不透明度。

浮窗默认置顶，拖动顶部小栏移动；设置按钮与额度区域不会触发拖动。右键可打开设置、刷新、取消置顶或关闭。关闭浮窗时若设置面板存在未保存的更改，会询问是否放弃；取消会保留两个窗口。关闭浮窗会停止它自己的额度读取连接，不会停止 Codex 任务；重新说“打开子代理浮窗”即可再次打开。该插件不设置开机自启。

`open_control_panel` 返回的 URL 可放在 Codex 浏览器侧栏。关闭承载 MCP 的任务后服务可能结束，此时重新调用该工具（或 `open_floating_window`）获取新的浮窗/页面。两类界面都不是 Codex 设置页中的原生扩展控件。

工具：`get_policy`、`preview_policy`、`set_strength`、`route_task`、`validate_assignment`、`open_control_panel`、`open_floating_window`。所有工具都不直接启动或收费调用模型。

在高级选项选择“DeepSeek 优先”并保存后，10–85% 档可将规格明确、难度不超过 3/5 的机械执行、实现和资料整理路由到 `deepseek-flash`，Sol / high 独立复核；该模式至少预留两次委派，分别用于执行和复核。90% 及以上继续按更高投入路由，100% 全部使用 Astra / max。实现与资料整理需 `executionSpecified=true`；未确定架构、视觉和高风险任务不因此下放。DeepSeek 通道缺失时回退 Sol 并说明原因。

按插件技能执行任务时，父代理读取路由后实际调用现有 `dsh_delegate(model="deepseek-flash", ...)` 并等待结果。面板的模型分配是策略预览，不是已完成模型调用的记录；插件不另存 API Key。

DSH 桥接源码纳入仓库 `bridges/`：运行目录需要同时包含 `dsh-mcp-bridge.mjs` 与 `dsh-fixed-model.mjs`。错误 cwd 会拒绝启动，取消通知或客户端断开会停止对应进程树；超时上限为 1100 秒，低于当前 MCP 1200 秒等待上限。桥接只返回完成结果和实际执行元信息，不接受通过用户设置替换本次模型。

### 首次配置桌面浮窗

首次安装先在仓库根目录执行 `.\install-personal.ps1`，再执行 `.\update-personal.ps1 -Launch` 准备 Electron 并启动浮窗。已有安装直接执行后者；更新脚本不会创建尚不存在的个人安装。

以后更新浮窗前，请先关闭已打开的浮窗，更新后重新打开以加载新版界面。

桌面运行时默认位于实际状态目录的 `runtime` 子目录。设置 `SUBAGENT_CONTROL_STATE_DIR` 时，运行时与设置一同跟随；可用 `SUBAGENT_CONTROL_RUNTIME_DIR` 明确共享另一个运行时，或用 `SUBAGENT_CONTROL_ELECTRON` 指定可执行文件。未自定义时仍为 `$CODEX_HOME/subagent-control/runtime` 或用户 `.codex/subagent-control/runtime`。带 `-Launch` 运行过一次更新脚本后，桌面会出现快捷方式“子代理强度控制”，之后可从它重新打开浮窗；桌面没有该快捷方式时用 `.\update-personal.ps1 -Launch` 创建（该快捷方式不注册开机自启）。

## 生效边界

该版本提供真实持久策略、派发计算与参数校验，由技能让原生子代理和现有 DSH 按策略执行。它不会改变当前主模型，不能强制拦截不经过本插件的调用，也不会无条件把策略注入每个任务。需要当前客户端支持原生子代理指定模型；DSH 缺失时，“省 Codex 额度”的机械任务回退 Luna，“DeepSeek 优先”任务回退 Sol，视觉与高风险路线绝不回退。模型质量与费用需要真实任务评测；100% 不代表未来任务 100% 正确。

停用插件只关闭本插件的路由、校验、额度读取与审计记录，不等于卸载：工具仍然存在但一律拒绝执行，设置文件与已有审计记录保持不变。

UI 的“永久锁定”表示路由引擎所有 19 档都会返回 Astra/max，并拒绝不匹配的派发校验；不是操作系统级模型调用拦截。图像生成、渲染等工具由任务本身调用，其费用独立。

设计规格明确的视觉工程实现可以下放，最终视觉验收仍回到 Astra/max。95% 等高档位会随难度更多使用 Astra，100% 全部类别使用 Astra/max。并行数和派发数是上限，不要求用满；必要升级不受预算上限限制。

## 本地运行与验证

在插件目录执行 `node scripts/server.mjs --standalone`，打开输出的 URL。通过 `SUBAGENT_CONTROL_STATE_DIR` 可指定开发设置目录；默认使用 `$CODEX_HOME/subagent-control` 或用户 `.codex/subagent-control`。开发测试只在工作区生成临时数据。该 standalone 模式不安装 Electron，只提供网页界面。

执行 `node --test tests/*.test.mjs` 验证路由、存储、HTTP 与 MCP。执行 `node scripts/configure-local.mjs` 生成当前目录对应的本机 MCP 配置。移动插件目录后需要重新生成配置并重新安装。

Windows 首次安装脚本是仓库根目录 `install-personal.ps1`；已有安装使用 `update-personal.ps1` 更新。后者验证已有个人市场来源，覆盖前在仓库 `artifacts/backups/` 保存上一份安装，再更新缓存版本并通过 Codex CLI 重新安装；不改动全局主模型与已有 DSH 配置。可显式传 `-SkipValidation` 跳过验证程序，正常更新默认保留验证。

**开发仓库、运行目录和安装缓存是三份副本。** 修改 `Documents/ChatGPT/subagent/plugins/subagent-control` 不会自动生效；必须执行仓库根目录的 `update-personal.ps1`。仓库 `.mcp.json` 仅用于源码目录开发；安装/更新会在用户 `plugins/subagent-control` 目录重新生成绝对启动路径。安装标记的 source 是开发来源，不能当成正在执行的路径。更新后开启新 Codex 任务并重新打开浮窗加载新版；旧任务中的 MCP 进程仍可能保留旧模块。请保留运行目录。卸载通过 Codex 插件 UI，保存设置独立保留。

桌面浮窗的运行时也由 `update-personal.ps1` 准备：加 `-Launch` 参数时，缺失的开发运行时先由 `prepare-desktop.ps1` 下载、校验，再复制到 `subagent-control/runtime` 并启动一次浮窗。下载阶段需要 Node.js 22.12+ 与网络。源码内包含锁定的依赖清单，不携带 Electron 二进制；不执行 `-Launch` 不影响网页与 MCP 模式。仓库 `artifacts/desktop-runtime/` 是可重新生成的开发副本，清理它不会删除状态目录中的已安装运行时；下一次 `-Launch` 会重新准备该开发副本。

保存锁使用带 PID 和唯一所有者标识的原子目录，设计上恢复已退出进程的锁，并保护仍存活的持有者；旧空锁文件超过 30 秒后可迁移回收。Windows 上把目录重命名到已存在的**文件**会直接替换而不报错，锁位是文件时抢占判断会被静默绕过（POSIX 会报 `ENOTDIR`）；现在抢锁前先探测槽位，非目录交给过期回收判定，两个锁保护用例已由失败转为通过。源码仓库的 `docs/verification.md` 记录了实际结果。设置文件损坏时仍显示错误并保留原文，不会静默重置。不要删除 settings.json。

## 依据

- https://www.electronjs.org/docs/latest/api/browser-window
- https://www.electronjs.org/docs/latest/tutorial/security
- https://learn.chatgpt.com/docs/agent-configuration/subagents
- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/api/docs/models/gpt-6-astra
- https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt
- https://api-docs.deepseek.com/quick_start/pricing/

“省 Codex 额度”和“省 API 费用”是路由偏好名称；路由阈值是工程策略，不是实时价格比较或实测质量预测。

外部委派的任务书、返回结果、父代理复核和重试仍有 Codex 消耗，DeepSeek 费用另计；没有完整任务对照数据就不能宣称总体更快或净节省多少。100% 档按设计统一使用 Astra/max，不会通过模型降档省额度。更新不会自行调低已保存的投入设置。
