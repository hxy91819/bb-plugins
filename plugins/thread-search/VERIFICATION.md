# Verification

2026-10-27：核心基于 `fork-base/desktop-v0.47.0`，界面在包含现有消息定位扩展的独立开发实例验证；使用全新数据库和合成消息，没有向 Agent 发送请求。

- 核心：app、server、CLI、Plugin SDK、Plugin Guide 类型检查及适用 lint 通过；相关 server、SDK、CLI、DB 和 daemon 契约共 150 项测试通过。
- 插件：5 项 DOM 行为测试、类型检查、锁定 SDK 0.6.37 的构建通过，npm audit 无漏洞。
- 独立审查发现并修复面板折叠后仍响应结果导航、重新打开后未聚焦搜索框的问题。两条回归用例在修复前失败，修复后通过。
- 真实 Chromium 桌面：640 个事件、160 轮历史，确认未加载的最早消息可搜索、加载并滚动定位；160 条匹配消息跨页循环；Cmd/Ctrl+Shift+F、Cmd/Ctrl+G、Shift+Cmd/Ctrl+G、Enter 和 Escape；头部按钮重新打开恢复焦点；隐藏面板不响应导航。
- CLI：中文关键词匹配 2 条，公共词匹配 160 条，`%_` 和去重音搜索匹配 160 条，agent-only 输入匹配 0 条；与 UI 和 API 结果一致。
- 390px 触屏 Chromium：从头部打开宿主侧面板，输入中文、显示高亮片段、点击定位并关闭；无横向溢出，app root 未添加 inert 或 aria-hidden。

未运行 Electron、iOS Simulator Safari 或真实 iOS 键盘验证。生产 BB 服务没有在本任务中替换；使用前需要包含配套核心搜索与消息定位接口的版本。
