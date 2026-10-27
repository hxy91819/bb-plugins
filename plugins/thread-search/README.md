# Conversation Search

搜索当前会话全部已保存的用户消息与助手回复，包括尚未加载的旧历史。显示匹配消息数、带高亮的片段，并定位到原消息；同一消息多次出现只计一条。搜索忽略大小写和重音，按字面匹配，支持中文单字、代码符号和 emoji。工具输出、系统通知、仅向 Agent 提供的隐藏输入不在范围内。正在生成的回复在完成后进入索引，使用 Refresh 更新搜索。

## 安装与兼容

```sh
bb plugin install git:https://github.com/hxy91819/bb-plugins.git@main --plugin thread-search
```

需要 BB fork 的 `feature/thread-content-search`（`threads.experimental_searchMessages`）和既有 `feature/thread-message-navigation`。构建仍使用集合固定的 SDK tarball；运行时检测新增搜索方法并验证返回值，旧宿主明确显示缺少的能力，不将部分结果当作完整搜索。

## 使用

点击会话顶部放大镜，或使用以下快捷键；搜索在 BB 原生侧面板打开，移动端沿用宿主面板。

| 动作 | macOS | Windows / Linux |
| --- | --- | --- |
| 打开并聚焦当前会话搜索 | ⇧⌘F | Ctrl+Shift+F |
| 下一条匹配消息 | ⌘G，或搜索框内 Enter | Ctrl+G，或搜索框内 Enter |
| 上一条匹配消息 | ⇧⌘G，或搜索框内 Shift+Enter | Ctrl+Shift+G，或搜索框内 Shift+Enter |
| 关闭搜索标签 | 面板内 Esc | 面板内 Esc |

打开、上一条和下一条通过 `app.commands.register` 注册，可在 Settings → Keyboard 调整；默认避开 BB 桌面端的窗口查找 ⌘/Ctrl+F；已有快捷键冲突时遵循 BB 的冲突处理，不覆盖用户绑定。上一条／下一条仅在当前会话搜索面板可见时生效；无会话页面保留浏览器查找。分屏按当前焦点会话处理。

结果每页 25 条，可跨页循环切换，点击片段定位到整条原消息；高亮显示在搜索片段中。Esc 使用带 revision 校验的公开 tabs API 删除本插件的搜索标签，保留其他标签。并发修改标签导致关闭失败时显示错误，可重试。

CLI 和 SDK 与 UI 共用核心搜索：

```sh
bb thread search '关键词' --thread <id> --limit 25 --offset 0 --json
```

SDK：`threads.experimental_searchMessages({ threadId, query, limit, offset, signal })`。返回 `{ total, matches }`；各命中含 `sourceKind`、`sourceSeq`、`text`、`highlightRanges`。消息按序号升序排列，查询 1–1000 字符，API 每页最多 100 条，默认 50 条。插件不复制消息或维护第二套索引。

## 开发

```sh
npm ci
npm run typecheck
npm test
bb plugin build .
```
