# BB plugins

BB 插件集合：团队身份、会话书签、ACP 图标，以及从个人 BB fork 迁出的侧栏和 ACP 定制。每个插件有独立的安装目录、插件 ID、配置与存储；共享一个源码仓库和验证入口。

| 安装名              | 插件 ID              | 用途                                              |
| ------------------- | -------------------- | ------------------------------------------------- |
| `team`              | `team`               | 团队身份、线程归属与有界活动查询                  |
| `thread-search` | `thread-search` | 会话全文查找、匹配计数、原消息定位与快捷键 |
| `bookmarks`         | `bookmarks`          | 会话文字书签与原消息定位                          |
| `acp-profile-icons` | `acp-profile-icons`  | ACP provider 的本地图标                           |
| `thread-list`       | `thread-list-extras` | 日期分组、项目标签、父会话独立未读提示及完整侧栏      |
| `acp`               | `acp-extensions`     | 自定义 ACP agent、能力探测、历史 fork 与 DSH 注册 |
| `acp-compat`        | `acp-compat`         | 插件托管的 ACP 协议适配与原生 steer，复用现有 provider |
| `machine-gateway`   | `machine-gateway`    | 自托管 HTTPS 机器入口、独立凭据与撤销            |
| `composer-tools`    | `composer-tools`     | 移动端逐段删除引用与当前草稿清空                  |

## 安装

需要包含配套公共扩展的 BB fork。当前验证基线固定为 `fork-v0.46.0-20261016.6`，source `47d099969891cab18398dc4064e836040159e6a3`；相同 SDK 版本号不代表上游 npm 包包含这些接口。

```sh
bb plugin install git:https://github.com/hxy91819/bb-plugins.git@main --plugin bookmarks
bb plugin install git:https://github.com/hxy91819/bb-plugins.git@main --plugin team
bb plugin install git:https://github.com/hxy91819/bb-plugins.git@main --plugin acp-profile-icons
```

`thread-list` 与 `acp` 使用独立 ID，不能与同职能内置插件同时作为生效提供者。迁移步骤与已验证状态见 [迁移说明](docs/migration.md)。请勿通过卸载有数据的插件来试探安装路径。

## 开发与验证

各插件使用自己的 package-lock.json，既能单独开发，也能在根目录串行验证，不依赖 BB monorepo workspace 包。

```sh
npm run install:plugins
npm run typecheck
npm test
BB_PLUGINS_RUNTIME_DIR=/path/to/bb-fork-v0.46.0-20261016.6 npm run build
```

重型检查遵循运行宿主的资源隔离约定。各插件的 SDK 固定为配套 BB Release 的公开 tarball URL，各 lockfile 记录实际 integrity；团队插件保留原有 .3 供应记录，集合联合构建使用 .6 兼容性基线。构建使用匹配 BB runtime 的 CLI；不把生成的 dist、凭据、诊断日志或本机存储提交到仓库。

验收记录：[五包检查及迁移回退](https://github.com/hxy91819/bb-plugins/actions/runs/39007931964)、[迁出后核心的源码 UI 与公开 Git 集合冷安装](https://github.com/hxy91819/bb-plugins/actions/runs/39009007741)。源码 UI 使用独立实例和合成线程，覆盖侧栏导航、标签与日期分组、普通 `/side` 消息及移动端长按 Queue 的实际队列结果。

## 维护

集合清单以 [.bb/plugins.json](.bb/plugins.json) 为准。插件的用途、命令与操作限制留在各自目录；新增或升级插件时分别运行它的检查，再运行受影响的联合流程。既有插件保持 `team`、`bookmarks`、`acp-profile-icons` 的 ID 和追加式迁移，保证存储身份连续。

导入来源及精确 commit 见 [migration-origins.json](migration-origins.json)。迁出的 BB 源码与 UI 组件使用上游 MIT License；第三方素材许可保留在对应插件目录。
