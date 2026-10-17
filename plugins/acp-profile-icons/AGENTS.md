# 提交与推送

- 本仓库的所有改动，在完成必要验证后立即 commit 并 push 到当前分支的远端；每个可独立交付的改动完成后执行，不积压到会话结束。
- 此规则是持续授权，提交和推送无需再次确认。提交前检查当前分支、`git status --short` 和 `git worktree list`，按文件或改动块暂存本次任务的内容，保留其他用户或 Agent 的未完成改动。
- 推送后确认本地提交已存在于远端。若 commit 或 push 失败，处理可解决的问题并重试；实际阻塞时明确报告未推送的提交和原因。

# 图标设计

- 图标的尺寸、主体占比、底板和主题色规则以 [README.md 的 Icon design and verification](README.md#icon-design-and-verification) 为准；修改图标前读取该规范，按实际显示尺寸验证。
