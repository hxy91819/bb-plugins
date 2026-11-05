> 2026-10-18：已由 BB 的 `acp-extensions.customAgents` 接管全部执行入口。本插件仅保留为迁移回退材料，日常保持关闭。AGY 额度采集由 ACP 提供者的独立维护适配器负责，额度面板不参与注册。当前说明见 `/root/.config/bb-acp/README.md`。

# Local Providers

从旧本地 account-limits 插件拆出的执行适配器，独立于额度面板的安装、升级和开关。

保留原有 provider ID：acp-agy、acp-copilot、acp-codexl，历史线程可继续使用。AGY 保留额度读取、技能目录和原有启动参数；旧 CodexL ACP 仅供历史线程兼容。账号池由 BB Account Pooler 管理。

Cursor SDK、Amp、DSH 等由 acp-extensions 管理，其 customAgents 图标使用 acp-extensions 命名空间。额度面板只消费公开 SDK，不注册或启停这些 provider。

本插件为本机配置，启动路径来自旧适配器，不适用于直接公开发布。

验证：npm run typecheck、npm test、npm run build。安装：bb plugin install /data/code/bb-plugin-local-providers --yes。查询 AGY 额度：bb local-provider-usage。

职责边界：
- local-providers：AGY、Copilot、历史 acp-codexl 执行与 AGY 原生额度采集。
- acp-extensions：Cursor SDK、Amp、DSH、Kiro 等 ACP 的发现与启动，customAgents 保存在该插件设置中；provider-acp 内置插件保持关闭以免重复注册。
- Account Pooler：codex/codexl 账号认证副本、切换与路由。导入跟随 auth.json 软链，导入后不持续同步源文件。
- account-limits：只读额度面板、展示偏好与提醒；可独立禁用，不影响以上执行入口。
- bb-dispatch：仅选择 provider/model；codexl 独立候选已移除，codex 走账号池。

2026-10-18 实测模型目录：AGY 6、Copilot 20、历史 CodexL 7、Cursor SDK 66、Kiro 2、CodeBuddy 32、DSH 2、Amp 4。此数字会随上游变化。opencode/omp/grok/hermes 当前 PATH 无命令且模型目录为空，不作为本机可用入口。普通 Cursor 保留关闭，使用 Cursor SDK。
