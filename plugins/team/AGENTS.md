# bb-team

Member service and migrations live in `src/members.ts`; wire schemas in
`src/contracts.ts`. `server.ts` connects these to the public Plugin SDK.
Read [README.md](README.md) for phase boundaries and local verification.

Append migrations; preserve their existing order and statements. Use public
`@get-bb/plugin-sdk` declarations pinned in package.json for host contracts.
Avatar metadata comes from `assets/avatars/manifest.json`; `src/avatars.ts` reads it and the original PNGs using package-relative URLs.

Tests own observable behavior at the service, real plugin entry and browser
identity boundaries. Use real SQLite; resource-heavy verification on a shared
BB development host follows the lock command in README. Keep third-party
notices in `licenses/` when changing vendored UI.
