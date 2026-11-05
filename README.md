# Retired local BB sources — 2026-11-05

Source snapshots of three former unmanaged directories, excluding generated dist and node_modules. SOURCE-SHA256.json records every original source/configuration/fixture file including dotfiles. This branch is archival only: do not install its vulnerable historical dependencies.

- bb-local-agents: former AGY npm 1.1.0 wrapper and legacy CodeBuddy cancellation proxy. Current AGY implementation: https://github.com/hxy91819/antigravity-acp/commit/3b4b7bde3d003b7400c4601e4579dbbb7c8a2967 (MIT). Current CodeBuddy adapter: bb-plugins/plugins/acp-compat. Legacy proxy originates from provider-codebuddy/src/proxy-source.ts in the BB fork (MIT).
- bb-plugin-account-limits: legacy provider-registration plugin 0.5.0. Compared every source file to hxy91819/bb-plugin-account-limits at e969b521ba50ac87e51208757a7a864525400754; none identical. That Git repository starts with the standalone dashboard, so this snapshot is distinct history, not a version upgrade for the live 0.4.0 dashboard.
- bb-plugin-local-providers: split from the legacy account-limits source; no separate Git origin. Compared with that legacy source: shares provider and test modules but has distinct server/package/usage-source/README. Disabled since migration to acp-extensions. Full source retained here.

Credentials and user databases are not included. Historical absolute launch paths are retained as source evidence, not installation instructions. Existing MIT notices remain with their upstream implementations.
