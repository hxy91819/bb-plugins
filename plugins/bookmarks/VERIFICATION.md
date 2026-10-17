# 验证记录（2026-10-16）：右侧面板与 GitHub 安装

本轮只修改插件仓库，没有修改 BB 源码、重启服务或停止进程。

## 自动化与审查

- `npm run typecheck`、`npm test`（4 项）、`npm run build`、`git diff --check`：通过。
- 前端 SDK harness + jsdom 覆盖默认项目过滤、取消过滤、会话分组与当前会话优先、跨 200 条分页的完整分组、搜索、消息跳转，以及新增后恢复过滤、清空搜索、定位与高亮；选区/消息 action 覆盖精确文字、成功打开和失败不打开。
- 原有真实 SQLite、持久化、备注、删除、分页及 CLI 测试通过，CLI 实现和 agent skill 未改动。
- autoreview 独立审查全部代码和 README 差异，无 P0/P1 发现。
- `npm audit --omit=optional`：0 漏洞；提交内容的敏感串检查未发现问题。

## GitHub 安装

代码提交：[67bf840](https://github.com/hxy91819/bb-plugin-bookmarks/commit/67bf8406378402dc17fe3b553e46f4f9dd5bc84d)。推送后先执行 `bb plugin uninstall bookmarks`，再执行：

```sh
bb plugin install https://github.com/hxy91819/bb-plugin-bookmarks --yes
```

生产安装成功，状态 `running`，source 解析到该 Git 提交，没有回退本地路径。根因已对照 BB 安装源码确认：Git 安装使用 `--omit=dev --omit=optional --ignore-scripts`，共享 RPC 契约的前端运行时导入 SDK 根包，因此 SDK 必须放在 `dependencies`，而不是 `devDependencies`。没有提交预构建产物或引入安装脚本。

## 生产 UI 实测

使用 dev-browser 打开本机生产 BB；证据目录：`/tmp/bb-bookmarks-panel-bbESXp`。下列截图均已读取检查。

| 验收 | 结果 | 截图 |
| --- | --- | --- |
| 面板“+”提供书签标签 | 通过，实际打开 | `09-panel-launcher.png` |
| 默认仅当前项目，按会话分组、当前会话最前 | 通过，较旧的当前会话排在较新的其他会话之前，另一项目不可见 | `01-default-current-project.png` |
| 取消过滤后按项目分组 | 通过，显示两个项目、三条书签 | `02-all-projects.png` |
| 真实 assistant 选区菜单新增，自动打开并定位高亮 | 通过，关闭标签后添加精确选区，自动重开，原消息编号 390 | `03-selection-menu.png`、`04-selection-auto-open.png` |
| 消息按钮新增，复用标签并定位高亮 | 通过，在取消过滤且搜索无结果时新增，恢复勾选、清空搜索；仅一个书签标签 | `07-message-auto-open.png` |
| 同会话点击滚动到原消息 | 通过，重复点击同一目标，消息顶部从 −1801.125px 回到 63.875px | `05-same-thread-jump.png` |
| 跨会话点击跳到原消息 | 通过，目标消息顶部为 64px，消息编号 1，书签文字与原文一致 | `06-cross-thread-jump.png` |
| 改备注、搜索、复制 | 通过，备注保存后搜索仅显示该条；clipboard readText 与原文逐字一致 | `08-note-search.png` |
| 删除与清理 | 通过，UI 删除一条，其余测试书签通过 CLI 删除；最终 `{bookmarks: [], total: 0}` | `10-cleaned-empty-panel.png`、`cleanup.json` |
| 移除旧侧栏及导航栏入口 | 通过，生产 DOM 中两类旧入口均为 0，注册测试也无 navPanel | 自动化与 DOM 检查 |

## 我自行引入的决定

- 列表分批读取所有匹配书签后统一分组排序，避免分页导致当前会话在后页或同组拆散；不改变 CLI 的分页契约。
- 新增时恢复当前项目过滤、清空搜索，确保新书签可见；定位状态只保留在浏览器内存中，不用每个书签的参数创建多个标签。
- 组内仍按创建时间倒序，其余组按最近书签的出现顺序。
- 增加 jsdom 开发依赖，在现有测试文件中验证真实面板组件的可观察行为。

本轮无未完成项。下方保留旧版本验证记录，其中侧栏/全页入口仅描述历史版本。

# 历史验证记录（2026-10-15）

隔离源码宿主：`feature/thread-message-navigation`，源码 commit `f7b53a6004`。
未修改 BB 仓库受跟踪文件，未在生产实例安装插件或写书签数据。
使用 verify-bb 流程；源码清单检查报 `Unmapped CLI family: browser`，属于现有清单漂移，未修改宿主清单。

## 自动化

- `npm run typecheck`：通过。
- `npm test`：3 项通过。公开 SDK harness 驱动选区/整条消息 action；真实 SQLite 覆盖 migration 重载、精确文字、来源、备注、搜索字面通配符、项目筛选、分页、分组、删除及 CLI；公开依赖扫描通过。
- `npm run build`：通过，生成 app/server bundle 与 metadata。

## 实测

证据目录：`/tmp/bb-bookmarks-verification-_paa6pz0`。截图经人工读取检查。

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| 用户消息按钮加书签、成功 toast | 通过 | `01-message-bookmarked.png`、`cli-list-initial.json` |
| assistant 选区保存精确文字 | 自动化通过，浏览器阻塞 | `tests.log`；见下方 provider 阻塞 |
| SQLite 持久化及 migration | 通过 | 自动化真实 SQLite；dev `plugin reload bookmarks` 后文字、备注仍在 |
| 侧栏底部最近与搜索 | 通过 | `02-recent.png`；全页搜索见 `04-note-search.png` |
| 全页按项目分组，显示标签、文字、备注、时间 | 通过 | `03-project-groups.png`，A/B 两个项目 |
| 编辑备注、搜索备注、复制文字 | 通过 | `04-note-search.png`、`cli-show.json`；浏览器 clipboard readText 与原文相等 |
| 点击跳回原会话、原消息 | 通过（用户消息） | 路由为原 thread 的 `#msg=1`，目标 user-seed:1 可见；`05-message-navigation.png` |
| 长内容滚动回原消息 | 通过（用户消息） | 添加 120 段长用户输入、展开后滚动；目标 top 从 -3330px 回到 64px；`02-recent.png`、`08-after-scroll-jump.png`、`scroll-result.json` |
| CLI list、按项目筛选、show、rm、--json | 通过 | `cli-list-grouped.json`、`cli-project.json`、`cli-show.json`、`cli-rm.json`、`cli-after-rm.json` |
| UI 删除与列表更新 | 通过 | `06-deleted.png`、`cli-after-ui-delete.json` |
| 旧宿主忽略消息定位选项仍打开会话 | 源码兼容，未运行旧宿主 | 调用公开 toThread，并传结构化可忽略选项；同步拒绝时回退普通 toThread |

## Provider 阻塞

按要求只尝试 `acp-devin`，SWE-2 模型（catalog ID `swe-2-medium`），CLI 显式请求 `--reasoning-level low`。宿主警告：

> Model "swe-2-medium" has no low reasoning variant; launching it at its default effort.

随后 Devin 返回周额度耗尽，未生成 assistant 回复。没有改用 Codex 或其他 provider，也没有伪造 assistant 回复。选择菜单的真实浏览器输入因此未完成；滚动定位另用真实长用户输入完成验证。

## 自行引入的决定

- 保留添加时的项目名称和会话标题快照；重复添加创建独立书签。
- 最近列表 10 条；全页每页 100 条；CLI 默认 100 条，支持 limit/offset（上限 200），输出过大时明确要求缩小分页。
- 搜索文字、备注、会话标题、项目名称，通配符视为普通文字；每条文字上限 200000 字符、备注上限 20000 字符。
- 使用插件自带 SVG 图标，避免宿主内置图标名差异。
- 固定公开 npm SDK 0.6.37；传递源码宿主新消息定位选项，不导入 BB 内部模块、不拼路由 hash。

## 独立审查

通过 autoreview + bb-model-routing 派发 `thr_4e4b7hhn6e`（Pi，cliproxy/gemini-3.8-flash-high，high），审查完整 staged tree。发现一项 P1：直接调用 navigator.clipboard 无宿主回退。已核实、接受并改用公开 `experimental_copyToClipboard`；返回 false 时显示失败提示。

浏览器负向对照：原生 writeText 抛 NotAllowedError；同一权限状态下点击插件复制按钮，SDK 回退复制成功，readText 与书签原文一致（`09-sdk-clipboard-fallback.png`、`clipboard-fallback.json`）。修复后类型检查、3 项测试及构建通过；已回写 accepted 裁决。

## 清理

两个验证会话最终均为 error（额度耗尽），没有运行中的 agent。已停止本次 pnpm dev 及浏览器 bookmarks-verify，确认 15534/23534/31534 均无监听；核对 ownership marker 后删除本次 dev 数据目录、临时项目目录、脚手架副本及 CLI wrapper。保留截图、命令结果和诊断日志，见证据目录 cleanup.json。
