# Composer Tools

移动端输入框的引用删除与草稿清空。使用公开的 composer banner、`plusMenu` 和 `useComposer().replace()`；覆盖层显示在编辑器外，实际编辑统一通过公开草稿接口完成。

- 在宽度不超过 767px 的粗触控屏幕上，展开输入框后，每段可见引用旁显示圆形 ×，触摸区域为 44px。
- 点击 × 移除对应引用，保留其他引用、正文、提及和附件，然后将输入焦点交回当前输入框。
- 输入框的 ＋ 菜单提供 **Clear all**，清空当前草稿的文字、引用、提及和已上传附件。支持桌面端和移动端。
- 清空只作用于当前草稿；聊天记录不受影响。移动端收起布局隐藏引用按钮。

## 安装

```sh
bb plugin install git:https://github.com/hxy91819/bb-plugins.git@main --plugin composer-tools --yes
```

插件 ID：`composer-tools`。无需设置、数据库迁移或 BB 服务重启。

## 开发

SDK 固定为集合的 fork Release，不能用相同版本号的上游 npm SDK 替换。

```sh
npm ci --legacy-peer-deps
npm run typecheck
npm test
bb plugin build .
```

`draft.ts` 处理引用删除和 UTF-16 提及范围调整。`quote-controls.tsx` 用原生输入框的 `data-app-composer`、`data-promptbox-editor-scroll`、可编辑 `role=textbox` 和 `blockquote` 标记定位；对嵌套输入框按最近 owner 区分。插件维护自己的覆盖层、观察器和事件监听器，在卸载时统一释放。

## 验证

在独立 BB 实例中创建合成会话，草稿包含两段引用、引用后的正文及附件；以移动端触屏展开输入框。

1. 点击第一段引用的 ×，确认另一段引用、正文和附件保留，继续键入的文字位于引用外；刷新后草稿保持。
2. 使用 ＋ → Clear all，确认文字、引用和附件清空，刷新后保持空草稿。
3. 输入长引用，滚动输入框和改变视口，确认 × 跟随引用标题位置，移出可见区域时隐藏；页面隐藏输入框时，覆盖层一同隐藏，恢复后重新定位。
4. 同时打开多个输入框，确认删除只影响所属草稿；停用插件后覆盖层消失，草稿保留，重新启用后按钮恢复。

引用序列与原生编辑器同步后才显示按钮；BB 更新输入框 DOM 或布局时，需要重新执行以上流程。
