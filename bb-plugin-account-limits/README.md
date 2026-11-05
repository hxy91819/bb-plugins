# Account Limits

本机 BB 0.42 的 CodexL、Kiro provider 插件，为现有 `acp-codexl` 和
`acp-kiro` 接入 BB 原生 `system.usageLimits`，供设置页和内置 Provider Usage 展示。
使用公开 SDK（当前 0.5.9）；不修改 BB 安装文件。

0.2.0 同时注册 `acp-agy`（Antigravity），其入口定义位于 `agy-provider.ts`。
AGY 已接入账户额度查询；`bb account-limits` 返回 CodexL、Kiro 和 AGY。

0.3.0 为 CodexL、Kiro 补齐原生技能根，bb 的 `/` 菜单与技能
列表能看到这些 CLI 自己的技能。

0.4.0 补上 AGY 的全局技能根，并为 Kiro 增加工作区级 `.kiro/skills`。

0.5.0 适配 BB 0.43 的 Provider Usage：它只展示通过可发现 RPC
`provider-usage.v1.listResources/getResource` 发布的配额源，而内置 `provider-acp`
只发布 `pluginId === "provider-acp"` 的 provider（如 `acp-cursor`）。本插件注册的
provider 因此由 `usage-source.ts` 自己发布，不依赖 `provider-acp.customAgents`
配置；数据仍取自 `system.usageLimits`。SDK 升到 0.5.9。

## CodexL 默认权限

`server.ts` 在 CodexL 的 ACP 启动环境中设置
`INITIAL_AGENT_MODE=agent-full-access`，新会话默认显示 **Full access**，
对应 `approval_policy=never`、`approvals_reviewer=user` 和
`sandbox_mode=danger-full-access`。
`codex-acp` 自带的默认模式是 **Approve for me**，会覆盖 Codex 配置文件里的
权限，因此只修改 `~/.codexl/config.toml` 无法改变 ACP 的默认模式。
修改入口后执行 `bb plugin build .` 和 `bb plugin reload account-limits`；
已运行会话需要重新启动或在会话模式中选择 Full access。

## Antigravity 入口

调用链：bb → SDK ACP bridge → Bun → `/data/code/bb-local-agents/agy-entry.mjs`
→ `antigravity-acp@1.1.0` → `/root/.local/bin/agy`。

依赖安装：`npm install --prefix /data/code/bb-local-agents --ignore-scripts --save-exact antigravity-acp@1.1.0`。
`AGY_BIN` 指定已有 CLI，`AGY_SKIP_DOWNLOAD=1` 禁止适配器另行下载 CLI。
启动文件在 `~/.agy-acp/models.json` 为空时先查询 `agy models` 并原子写入缓存，
避免 bb 的首次 `session/new` 赶在后台模型发现之前。

**仅支持 Full Access**：上游 1.1.0 无条件添加 `--dangerously-skip-permissions`，
因此本 provider 不提供 Accept Edits 或 Auto，也不宣称支持 bb 审批交互。
会话绑定在 `~/.agy-acp/sessions.json`，原生对话在
`~/.gemini/antigravity-cli/conversations/`。本次验证模型发现和文本对话；
并发会话写入、文件编辑与工具交互不在已验证范围内。

会话、模型发现、权限交互和恢复均由 SDK 的 ACP bridge 处理，插件仅截取
`provider/usage`。provider ID 和原生 session ID 保持不变。

## 当前启用状态

2026-10-06 CodexL 已迁移到原生 `codex-l`，旧 `acp-codexl` 仅保留历史线程的执行与登录能力，不再发布配额。配额由原生 Codex 插件读取同一共享软链提供，避免重复卡片；AGY 配额仍由本插件提供。此本地适配通过 `bb plugin build .` 和 `bb plugin reload account-limits` 生效，无需重启 BB。

2026-10-03 已移除 `acp-kiro` 注册：当前账户认证已失效。Kiro 的额度解析代码保留，恢复使用时需重新注册 provider。

## 查询来源

- AGY：运行 `/root/.local/bin/agy --print /usage`，读取模型组、5 小时/每周剩余百分比和 UTC 重置时间；转换为 BB 的已用百分比。仅执行 CLI 内置额度命令，不发起模型对话。解析 stdout，不将认证初始化期间的 stderr 日志误判为最终未登录。未知格式、无数据或非零退出均报错。
- CodexL：启动 `/root/bin/codexl-bb app-server`，执行 `initialize`、
  `account/read`、`account/rateLimits/read`。只查询账户，不启动 agent turn。
  优先显示 `rateLimitsByLimitId` 的全部额度桶，兼容旧单桶响应。
- Kiro：运行 `/root/.local/bin/kiro-cli chat --no-interactive /usage`，读取
  套餐名称、已用/总 credits 和重置日期。百分比使用原始数值计算，不使用 CLI
  的整数进度条。CLI 未提供时区或重置时刻，因此日期写入标签，`resetsAt` 留空。
  仅显示套餐 credits，不将购买的补充 credits 或超额计费合并到套餐额度。

认证由现有 CLI 管理，不复制或输出 token。未登录、过期、格式变化、查询超时
分别返回状态或错误，不将失败显示为零用量。查询有输出上限和 20 秒时限；
退出前关闭输入，必要时清理查询进程组。Codex 凭证直接通过现有软链读写，wrapper 不再复制回共享目录。
同一 bridge 内的并发查询合并；周期刷新由 BB 原生服务和 Provider Usage 管理。

## 原生技能

bb 只索引 provider 声明里顶层 `experimental_nativeSkillRoots` 与
`experimental_resolvesNativeRoots` 给出的目录；写进 `acpLaunchSpec.nativeSkillRoots`
不会进入技能索引。

- CodexL：静态声明 `~/.agents/skills`（user），以及 `.codex/skills` 和向上到仓库根的
  `.agents/skills`（project）。`native-roots.ts` 再按 wrapper 的规则解析运行态目录
  （`ITFS_CODEX_LOCAL_HOME` → `CODEXL_HOME` → `~/.codexl`，并拒绝共享 FUSE 目录），
  补上 `<CODEX_HOME>/skills` 与其 `.system`。
  codex 插件技能（`openai-templates:*` 等，来自 `<CODEX_HOME>/plugins/cache`）
  默认屏蔽；把 `native-roots.ts` 的 `INCLUDE_CODEX_PLUGIN_SKILLS` 改成 `true`
  即恢复与 codex 一致（会多出约 20 条 vendor 技能）。
- Kiro：静态声明 `~/.kiro/skills`（user）与 `.kiro/skills`（project）。`kiro-cli-chat`
  以 `skill://.kiro/skills/*/SKILL.md` 解析技能；两级都用探针 skill 实测可见。
- AGY：静态声明 `~/.gemini/config/skills`（user，本机链到 `~/.agents/skills`）。
  探针实测 agy 能列出该目录下的个人技能；工作区级 `{workspace}/.agents/skills`
  虽出现在 agy 自带文档里，但探针未复现，暂不声明。
- GitHub Copilot 不声明：本机没有可确认的技能目录。

`native-roots.test.ts` 用 `fixtures/native-roots` 覆盖环境优先级、默认屏蔽、
显式开启插件技能和 `.system` 技能；`providers.test.ts` 守住每个 provider 的
声明根，缺一处就会让该 provider 在 bb 里只剩自带技能。

## 使用

```bash
bb account-limits
bb account-limits --host <machine-id>
bb plugin enable provider-usage
```

`bb account-limits` 调用 BB 的原生查询服务，只返回本插件当前启用配额能力的 provider。原生 Codex/CodexL 配额通过 `bb settings usage` 查询。
入口路径记录在 `server.ts`，本插件按当前机器配置，迁移机器时需要调整路径。

## 构建与检查

```bash
npm install --include=dev
npm run typecheck
npm test
bb plugin build .
```

离线测试包含额度格式、精度、失败状态、超时/取消、关闭清理，以及公开 SDK
conformance suite（握手、RPC 错误、会话启动/恢复、消息事件和释放）。
`test-runtime.mjs` 为 SDK 的 CJS 依赖提供 require，实际 host bundle
由 `bb plugin build` 自动加入对应模块加载头。

## 注册与回退

安装前保存 `provider-acp.customAgents` 中两个入口的配置，并仅移除这两条。
新插件接管相同 ID，其他自定义入口保留。不要让两个插件同时注册相同 ID。

```bash
bb plugin install /data/code/bb-plugin-account-limits --yes
```

回退时先禁用 `account-limits`，再将 `previous-custom-agents.json` 中的两条入口
合并回当前 `provider-acp.customAgents`；保留期间新增的其他入口。无需删除线程。

数据来源文档：
- https://developers.openai.com/codex/app-server#6-rate-limits-chatgpt
- https://kiro.dev/docs/reference/slash-commands/#usage
