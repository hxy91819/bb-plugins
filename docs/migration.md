# 迁移到集合仓库

本次保持 team、bookmarks、acp-profile-icons 的插件 ID、存储 key 和追加式数据库迁移不变。旧仓库继续保留已发布历史；后续源码集中在本集合。

## 既有插件

先构建集合中的插件，再执行：

```sh
node scripts/migrate-installed.mjs team bookmarks acp-profile-icons
```

脚本使用当前 `bb` CLI 的目标实例，支持标准 `BB_SERVER_URL`。已有本地路径插件通过 BB 的路径移动接口切换，保留启用状态、配置与存储。已有 Git 安装的书签插件在移除安装登记前保存配置，再安装相同 ID 的集合版本并恢复配置；BB 的移除操作保留插件数据库和 KV，书签数量与首条 ID 会在切换后核对。失败时恢复原安装地址与配置。

每次迁移的回执保存在本机 `~/.cache/bb-plugin-migration/`，不进入仓库。当前脚本只适用于上述三个无凭据、无定时任务迁移的插件，不用于 provider 或账号池。

迁移后的本机安装源是本集合的稳定 checkout 路径。以后 git pull 后重新构建并 `bb plugin reload <id>`。其他机器新装可直接使用 README 的 Git collection 安装命令；已安装机器先按本节保留数据迁移。

## 迁出的内置插件

| 集合安装名 | 新 ID | 原内置插件 | 配置迁移 |
| --- | --- | --- | --- |
| thread-list | thread-list-extras | thread-list | 复制 `bb thread-list prefs list --json` 中的偏好，Move 操作 key 改用 thread-list-extras/move，再选择新列表 |
| acp | acp-extensions | provider-acp | 复制 customAgents 配置，保留 acp-* provider ID；停用原内置提供者后由新插件注册 |

这两项需要在隔离实例中验证后切换。保留原内置插件的数据，避免通过卸载来清除配置。启用新提供者后不要同时启用两份相同职责的提供者。

## 配套核心

团队、列表贡献、活动查询和消息定位仍依赖 BB fork 提供的公共扩展。ACP 共享 bridge 的 resume、steer、模型错误与 checkpoint 修复也仍由共享 SDK 交付；集合没有复制第二套协议实现。账号池 AI fallback 留在原账号池插件，Codex warning 过滤保留小补丁。
