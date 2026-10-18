# BB plugin collection

Plugin membership and install names live in `.bb/plugins.json`. Each directory owns its package.json, lockfile, plugin ID, settings and storage. Read its local AGENTS.md and README before editing it.

Use public `@get-bb/plugin-sdk` contracts pinned in that plugin's manifest. Keep existing plugin IDs and append database migrations. The collection's BB runtime is pinned in `bb-runtime.json`; it is a compatibility baseline, not a second source for each plugin's dependency version.

Run checks for the changed plugin and the affected combined workflow through the host's resource isolation runner. Root scripts serialize packages. Use `docs/migration.md` before changing an installed plugin's source; credentials and user databases stay outside Git.

Keep imported license notices and the original source evidence in `migration-origins.json`. Source and configuration live here; active BB core patches remain in the BB repository's `.fork/branches`.

新增功能或改变维护边界、插件 ID、仓库位置时，同步 BB 的[功能维护与插件更新索引](https://github.com/hxy91819/bb/blob/fork-tooling/docs/feature-index.md)。普通版本变化从远端与实际安装源读取，不在索引复制版本清单。

## 交付收尾

- 整项任务完成必要验证和适用的 review 后，统一提交本任务文件，推送到个人远端 `origin` 并核对远端 SHA；这是持续授权，无需再次确认。中间可保存检查点提交，发布统一放在最终交付阶段。
- 本集合通过 `main` 的 `.bb/plugins.json` 以 Git collection 分发。产品改动须进入并推送 `main`，跟踪该 SHA 的 `.github/workflows/ci.yml` 到成功，再交付 commit 与安装引用；只推开发分支或启动 CI 不算发布完成。已有相同 SHA 的成功流水线时复用，不重复触发。
- 纯规则或文档改动同样提交、推送并核对必要 CI，沿用 Git 分发，不为其另建运行包或 npm 发布。用户明确要求仅验证、不推送或不发布时按其要求执行；实际受阻时报告未完成步骤。
- 发布代码与安装到目标实例分别核验；本次任务已有安装、迁移或服务操作授权时继续执行，不因推送而新增服务替换授权。
