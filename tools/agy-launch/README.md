# AGY launch helper

BB 的 AGY 模型目录预热入口由集合维护；适配器实现继续来自 [antigravity-acp 个人 fork](https://github.com/hxy91819/antigravity-acp)，依赖锁定到已验收的完整 Git commit，保留同轮 steer 与 hook 支持。此目录不注册插件或 provider，因此不加入 `.bb/plugins.json`；注册仍由 `acp-extensions.customAgents` 负责。CodeBuddy 使用集合的 `plugins/acp-compat`。

安装依赖：`npm ci --prefix tools/agy-launch --ignore-scripts`。需要本机已有 Bun 和登录后的 `agy` CLI，不运行依赖的 CLI 下载脚本。

在完整读取 customAgents 后，仅合并 AGY 的 `args` 为 checkout 中本文件旁的 `agy-entry.mjs` 绝对路径，保留其他字段与条目。`command` 使用本机 Bun；`env.AGY_BIN` 指向本机 agy，保留 `AGY_SKIP_DOWNLOAD=1`。迁移前后用真实 BB 会话验证，不能以模型发现代替。

入口来自 antigravity-acp 的 `3b4b7bde3d003b7400c4601e4579dbbb7c8a2967`，仅将本地 index 导入改为锁定依赖导入；MIT 许可见 LICENSE。升级时先更新精确 commit 和 lockfile，再运行隔离的安装、语法检查、依赖审计和真实会话验收。常规 Dependabot 可更新传递依赖；fork commit 升级需手动验收。
