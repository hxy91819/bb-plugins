# BB plugin collection

Plugin membership and install names live in `.bb/plugins.json`. Each directory owns its package.json, lockfile, plugin ID, settings and storage. Read its local AGENTS.md and README before editing it.

Use public `@get-bb/plugin-sdk` contracts pinned in that plugin's manifest. Keep existing plugin IDs and append database migrations. The collection's BB runtime is pinned in `bb-runtime.json`; it is a compatibility baseline, not a second source for each plugin's dependency version.

Run checks for the changed plugin and the affected combined workflow through the host's resource isolation runner. Root scripts serialize packages. Use `docs/migration.md` before changing an installed plugin's source; credentials and user databases stay outside Git.

Keep imported license notices and the original source evidence in `migration-origins.json`. Source and configuration live here; active BB core patches remain in the BB repository's `.fork/branches`.
