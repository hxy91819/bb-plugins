# 迁移到集合仓库

本次保持 team、bookmarks、acp-profile-icons 的插件 ID、存储 key 和追加式数据库迁移不变。旧仓库继续保留已发布历史；后续源码集中在本集合。

## 既有插件

先构建集合中的插件，再执行：

```sh
node scripts/migrate-installed.mjs team bookmarks acp-profile-icons
```

脚本使用当前 `bb` CLI 的目标实例，支持标准 `BB_SERVER_URL`。已有本地路径插件通过 BB 的路径移动接口切换，保留启用状态、配置与存储。已有 Git 安装的书签插件在移除安装登记前保存配置，再安装相同 ID 的集合版本并恢复配置；BB 的移除操作保留插件数据库和 KV，书签数量与首条 ID 会在切换后核对。失败时恢复原安装地址与配置。

现版书签界面统一英文，迁入集合时不再恢复旧版 `language` 设置；原值仍保存在私有回执中，失败回退到旧插件时完整恢复。

每次迁移的回执保存在本机 `~/.cache/bb-plugin-migration/`，不进入仓库。当前脚本只适用于上述三个无凭据、无定时任务迁移的插件，不用于 provider 或账号池。

迁移后的本机安装源是本集合的稳定 checkout 路径。以后 git pull 后重新构建并 `bb plugin reload <id>`。其他机器新装可直接使用 README 的 Git collection 安装命令；已安装机器先按本节保留数据迁移。

## 迁出的内置插件

| 集合安装名 | 新 ID | 原内置插件 | 配置迁移 |
| --- | --- | --- | --- |
| thread-list | thread-list-extras | thread-list | 复制 `bb thread-list prefs list --json` 中的偏好，Move 操作 key 改用 thread-list-extras/move，再选择新列表 |
| acp | acp-extensions | provider-acp | 复制 customAgents 配置，保留 acp-* provider ID；停用原内置提供者后由新插件注册 |

构建后使用专用迁移入口：

```sh
node scripts/migrate-native.mjs thread-list
node scripts/migrate-native.mjs acp
```

脚本保存私有配置回执，复制偏好并核对读回值，切换列表选择、停用旧提供者，失败时恢复旧提供者和选择。ACP 迁移要求所有 ACP 会话已空闲或报错；保留相同 acp-* provider ID、自定义 agent 配置和原内置插件的数据。已有新插件安装时先手动协调其配置，脚本不会覆盖它。

`BB_PLUGINS_RUNTIME_DIR=/path/to/runtime npm run test:migration` 在全新合成实例中验证上述五插件的安装与迁移；不会读取用户库。

## 配套核心

团队、列表贡献、活动查询和消息定位仍依赖 BB fork 提供的公共扩展。ACP 共享 bridge 的 resume、steer、模型错误与 checkpoint 修复也仍由共享 SDK 交付；集合没有复制第二套协议实现。账号池 AI fallback 留在原账号池插件，Codex warning 过滤保留小补丁。

## 旧非 Git 本地目录收口（2026-11-05）

AGY 启动辅助入口现由 `tools/agy-launch` 管理，适配器锁定到当前在用 fork 的 commit，避免退回旧 npm 1.1.0。CodeBuddy 的旧取消代理已由集合 `acp-compat` 取代，不恢复旧实现。customAgents 只改 AGY args，保留其他配置；本机兼容命令 bb-codebuddy-acp 改为调用现有 acp-compat runner。无需重启服务。

旧 local-agents、account-limits 0.5.0、local-providers 的完整源码、配置样例、隐藏 fixtures 和锁文件已保存到 [归档分支](https://github.com/hxy91819/bb-plugins/tree/archive/unmanaged-local-20261105)，SHA `219943f55372353ef74dd6c705c5f83a669eb88c`，逐文件摘要见该分支 SOURCE-SHA256.json；不保存 node_modules 与 dist。旧依赖仅作源码证据，不再安装。旧 account-limits 0.5.0 是注册 provider 的旧插件，不能覆盖当前独立看板 0.4.0；其版本号不表示新旧维护关系，当前 Git 源及安装保持原样。

本机私有配置回执继续放在 bb-acp-config-migration 缓存，不进入 Git。停用的 local-providers 安装登记在保存配置后移除，数据库保留；不启用旧插件。
