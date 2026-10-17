> 本插件已迁入 [hxy91819/bb-plugins](https://github.com/hxy91819/bb-plugins/tree/main/plugins/bookmarks)。新装使用 `bb plugin install git:https://github.com/hxy91819/bb-plugins.git@main --plugin bookmarks`；已有安装按集合仓库的迁移说明保留配置与数据。下文旧 Release 记录保留作来源证据。

# Bookmarks / 书签 · BB plugin

将会话文字存为书签，按项目查看，并回到原会话的原消息。独立插件，运行时仅使用公开 `@get-bb/plugin-sdk`，数据保存在 BB 为插件提供的 SQLite 中。


Save conversation text as bookmarks, browse by project, and jump back to the source message.
Install with `bb plugin install git:https://github.com/hxy91819/bb-plugins.git@main --plugin bookmarks`.
Use **Add bookmark** on a message or selected assistant reply text, then open **Bookmarks**
in the right panel to search, copy, edit notes, or delete entries.

## Language / 界面语言

The UI supports English and Simplified Chinese. The plugin's **Language / 语言**
setting defaults to **Auto / 自动** (`auto`): `navigator.language` starting with
`zh` selects Simplified Chinese; all other languages select English. Choose
**English** (`en`) or **简体中文** (`zh-CN`) to override it. Reload the browser after
changing the setting so message menus, panel titles, content and date formatting
all use the same language. The setting is shared by this BB instance; auto detection
runs separately in each browser. CLI descriptions/errors and the agent skill use English.
Thread titles use BB’s explicit title or automatic fallback. Legacy missing title
snapshots are repaired when read, so existing bookmarks and title search recover too;
valid saved titles are preserved.

界面支持英文和简体中文。插件设置中的 **Language / 语言** 默认 **Auto / 自动**：
浏览器 `navigator.language` 以 `zh` 开头显示中文，其余显示英文。
可选 **English** 或 **简体中文** 强制覆盖。修改后刷新浏览器，让菜单、标签、面板和日期统一切换。
设置对当前 BB 实例生效，自动模式按各浏览器分别判断；CLI 与 agent skill 使用英文。

## 安装

需要支持 SDK 0.6.37 的 BB、Node.js 22 或更新版本及 npm：

```sh
bb plugin install git:https://github.com/hxy91819/bb-plugins.git@main --plugin bookmarks
```

安装会跟踪仓库默认分支，BB 自动安装运行依赖并构建前后端。

## 使用

- 选中 assistant 回复文字，在选区菜单点击“加书签”，保存精确选区。
- 消息操作栏的“加书签”保存整条消息文字，支持用户消息及 assistant 回复。添加成功自动打开右侧“书签”标签页，恢复当前项目过滤、清空搜索并滚动高亮新书签。
- 从会话右侧面板的“+”选择“书签”打开标签页。默认勾选“仅当前项目”，按会话分组，当前会话排在最前；取消勾选显示全部项目，按项目分组。
- 可搜索文字、备注、会话标题及项目名称，复制文字、删除和编辑备注。点击文字回到原会话的原消息，同会话内直接滚动。没有侧栏底部或导航栏全页入口。

定位使用 `toThread(threadId, { experimental_messageSeq })`。支持此扩展的宿主会加载并滚动到目标消息；较旧宿主忽略该选项时仍会打开会话。定位粒度是消息，不会高亮选中的句子。原会话或消息已删除时，书签文字仍保留，宿主负责显示目标不可用。

书签保留添加时的项目名称、会话标题、文字、创建时间和原消息编号。会话显示标题优先使用 `title`，没有时使用 BB 的自动标题 `titleFallback`；读取旧书签时会补全之前误存的空标题或“未命名会话”，已有有效标题快照保持不变。原会话不可用时仍保留书签文字。重复添加会创建独立书签。每条文字最多 200000 字符，备注最多 20000 字符。搜索将 `%`、`_` 按普通文字处理；SQLite 默认的 LIKE 不提供完整 Unicode 大小写折叠。

## CLI

```sh
bb bookmarks list --json
bb bookmarks list --project proj_example --limit 50 --offset 0 --json
bb bookmarks show <id> --json
bb bookmarks rm <id> --json
```

`list` 返回 `{bookmarks, total}`，按创建时间倒序；`show` 返回单个完整书签；`rm` 返回 `{id, removed}`。书签含 `id`、`threadId`、`messageSeq`、`projectId`、`projectName`、`threadTitle`、`text`、`note`、`createdAt`。无 `--json` 时输出缩进 JSON，便于人工读取。无效参数及不存在的 ID 返回非零退出码，JSON 模式错误输出至 stderr。列表超过宿主 CLI 字节限制时，请减小 `--limit` 分页读取。

## 开发与数据

本地路径安装仅用于开发，目录需要保留：

```sh
npm ci
bb plugin build
bb plugin install . --yes
```

修改源码后执行 `bb plugin build` 和 `bb plugin reload bookmarks`，或用 `bb plugin dev`。

```sh
npm run typecheck
npm test
npm run build
```

SDK 固定为集合兼容基线的公开 BB fork Release tarball（SDK 0.6.37），放在 `dependencies`：共享 RPC 契约在浏览器运行时需要 SDK 根包，而 Git 安装只安装运行依赖（忽略安装脚本）。不需要提交 `dist/`。消息定位扩展依据配套 BB 源码契约，以结构化选项调用，同时兼容尚未包含该选项的公开声明。

面板分批读取匹配书签（每次最多 200 条），统一分组排序；组内按创建时间倒序，其余组按最近书签出现顺序。新增定位和高亮只保留在当前浏览器会话，不写入标签参数，连续新增会复用同一个标签页。

数据位于当前 BB 实例的 `plugins/bookmarks/data.db`；使用插件存储的追加式 migration，搜索和分页在 SQLite 中完成。卸载、备份及数据目录生命周期由 BB 管理。测试通过公开 SDK harness 操作真实 SQLite，覆盖重载持久化、搜索、项目筛选、备注、删除、分页与 CLI 行为。
