# bb-team

Independent BB plugin for trusted, self-selected team members, native thread
attribution, member grouping/row labels and on-demand retained activity.
Requires [BB fork `fork-v0.46.0-20261014.3`](https://github.com/hxy91819/bb/releases/tag/fork-v0.46.0-20261014.3),
source `9ddb184943a3ce7e5820fb1d141c782c958af521`, and its matching SDK.
Stock BB 0.46.0 / SDK 0.6.37 do not supply these extensions. The SDK dependency
is pinned to the verified BB Release asset URL and integrity.

## Implemented behavior

- Plugin startup creates exactly one default `Admin` with the dedicated `admin`
  avatar in a synchronous SQLite immediate transaction. No client is selected
  automatically. An appended migration fixes the existing administrator's name
  and avatar while preserving its UUID, other members and thread attribution.
  Admin's profile is fixed; ordinary members remain editable. `initialize {}`
  is idempotent; obsolete name/avatar initialization inputs are rejected.
- Administrator identity controls only member creation. Names are trimmed and
  contain 1–80 Unicode code points; duplicate names are allowed. Exact name
  resolution reports ambiguity, while list search/pagination runs in SQL with
  bounded pages and stable ID cursors. A cursor is the last returned member ID;
  use the same search/name on subsequent pages. Results reflect current data.
- Update-self has one selected `memberId`, with no separate target field.
  Selecting an identity is a team convention, **not authentication**. Anyone
  with a BB session can self-select the administrator; this plugin adds no
  passwords, email login or BB permissions.
- Browser identity is partitioned by app origin, persisted plugin server UUID,
  and the browser's storage profile/container. Persistent defaults use
  `localStorage`; window overrides use `sessionStorage`, including explicit
  `null`. A window pins the initial value, so another window's default change
  does not switch it. The main “选择” action writes both; the advanced only-this-window action writes session
  only; clear writes null; restore rereads the current default and pins it;
  forget deletes the default and clears this window. Storage failure falls
  back to memory and reports that persistence cannot be guaranteed.
- The public SDK does not expose the native app's active profile identifier.
  Browser profiles with separate storage are isolated; native profiles sharing
  both origin and storage currently share that default. Automatic native
  profile isolation needs a public host scope API and is not claimed here.
- CLI runs **on the server** and uses explicit `--actor` / `--member`. It does
  not implement client-local select/show/clear or write a global current user.
  Browser identity and CLI identity never synchronize implicitly.
- Timezone is one ordinary `bb.settings.define` field, validated as IANA.
  The server uses UTC while unset; the UI suggests the browser timezone until
  a team preference is saved. Timezone saving is independent of default Admin
  creation and needs no administrator identity.
- An app-wide identity picker opens once after an absent or invalid saved
  identity has been confirmed. Loading/errors are distinct; cancellation does
  not loop. A persistent avatar/name button remains available with the sidebar
  closed, and the sidebar/Team entry opens the same picker. Ordinary selection
  remembers the choice; window-only and forgetting controls are secondary.
- Twenty selectable member PNG avatars plus one dedicated Admin avatar use `assets/avatars/manifest.json` as the only
  inventory. Only the backend reads the committed PNGs, using package-relative file URLs,
  and serves same-origin authenticated plugin HTTP routes. URLs include content hashes;
  matching hashes use immutable caching, and routes support ETag validation.
  The frontend and CLI receive only metadata and URLs.
- Navigation, plugin settings and sidebar footer expose the member UI. Compact
  profile editors use BB's vendored persistent drawer and keep app-root
  controls available. Committed profile changes publish `members.changed`;
  reconnect refetches current state and profiles. Only fixed member IDs are
  copied into thread metadata; names and avatars come from current profiles.
- Native creation, fork and handoff synchronously capture the window's current
  identity. Backend preparation validates it before creation. An explicit null
  remains unassigned; a nonexistent explicit identity fails visibly and keeps
  the draft. Agent child creation may inherit its parent's member, but a fork's
  source does not implicitly supply an identity. Starting/retrying an existing
  thread never reassigns it. Old threads remain unassigned.
- Select **Threads → Organize → Team members** in the native sidebar. Group IDs
  use member UUIDs; member groups show native project badges without repeating
  member avatars or names on rows. Other modes show only a leading member
  avatar, with the name in its tooltip/accessibility label. Unassigned rows
  omit that avatar. Children stay in the native tree. Group loading/error
  states remain distinct from unassigned; metadata and profiles use bounded
  batches. This requires list contribution capability version 2.
- `bb team activity` queries the host's retained evidence only when requested.
  It includes archived threads and today's continuation of older threads,
  excludes inherited fork history where boundaries are known, and reports
  `forkBoundaryGaps` when they are not. It describes currently attributed BB
  progress, not who performed each message or proof that a goal succeeded.

## Distribution

See [installation and release artifacts](docs/distribution.md) for the complete
archive and fixed-tag Git installation instructions. The committed
[supply record](release/bb-supply.json) pins the verified compatible BB tag,
source, runtime/SDK checksums and SDK integrity.

## Development and installation

Requires the matching BB runtime with Node 24. `npm ci` installs the fork SDK
from its immutable Release URL; no candidate overlay is needed.

```bash
git clone https://github.com/hxy91819/bb-team.git
cd bb-team
export BB_TEAM_RUNTIME_DIR='/absolute/path/to/extracted/bb-runtime'
export PATH="$BB_TEAM_RUNTIME_DIR/bin:$PATH"
npm ci
npm run check
```

`build` invokes the selected matching runtime's public `bb plugin build`,
checks source provenance and isolates child npm configuration. It never falls
back to stock or the main service's `BB_CLI`. Asset loading needs no
npm lifecycle hook: BB managed Git installation disables scripts and omits dev
and optional dependencies. `src/avatars.ts` and `dist/server.js` both sit one
level below the committed `assets/` directory, so runtime URLs work in source
and built packages. `node scripts/check-install.mjs` clones the committed Git tree and checks it
without generated files using those production-only install flags.
The runtime has no BB source checkout dependency. Generated bundles, source
maps, SQLite files and local secrets are not committed. The package is marked
private to prevent accidental npm publication.

For an explicitly chosen **development** BB instance:

```bash
BB_CLI="$BB_TEAM_RUNTIME_DIR/bin/bb" BB_SERVER_URL=http://127.0.0.1:YOUR_DEV_PORT "$BB_TEAM_RUNTIME_DIR/bin/bb" plugin install . --yes
```

Do not interpret these examples as automatic installation into your normal BB
instance. `scripts/live-smoke.mjs` starts the selected matching server with a fresh
temporary data directory, installs this package, exercises real browser and
wire flows, then stops the server and deletes only its own temporary data.
It installs a temporary copy so changed-bundle reload verification cannot
modify the checkout. Set `BB_TEAM_EVIDENCE_DIR` to retain screenshots. For a complete release archive
installation, extract it and install production dependencies first, then set
`BB_TEAM_INSTALL_DIR` to that directory. The smoke installs that actual path
without copying source or linking development dependencies; keep the directory
until the isolated run finishes. This mode cannot be combined with the legacy
upgrade journey.
Extended native creation/fork/handoff and activity journeys additionally need
`BB_TEAM_TEST_PROVIDER_DIR`: a disposable public-SDK provider plugin registering
`team-echo` / `fake-model`, with checkpoint forks and deterministic echo turns.
The acceptance evidence retains the fixture used for that run. Without this
input, the script runs member/UI/lifecycle checks and skips provider journeys;
it does not claim a complete thread integration run.

```bash
node scripts/live-smoke.mjs
# Upgrade journey: installs the exact older local Git tree in the disposable
# instance, then reloads current source and checks UUID/data/browser continuity.
BB_TEAM_UPGRADE_FROM=cd395a06fae2d6c8c4b91597cfd7688b4c992a7f node scripts/live-smoke.mjs
```

On a shared BB development host, run each entire heavy job under the shared
resource lock and the host-provided resource isolation runner:

```bash
flock /tmp/bb-team-verification.lock "$BB_RESOURCE_RUNNER" --profile package -- npm run check
flock /tmp/bb-team-verification.lock "$BB_RESOURCE_RUNNER" --profile package -- node scripts/live-smoke.mjs
```

Set `BB_RESOURCE_RUNNER` to that host's `scripts/run-resource-isolated` executable.
Queueing for the lock is expected. Browser smoke needs Playwright Chromium and
WebKit installed (`npx playwright install --with-deps chromium webkit`). It is
separate from the ordinary CI job.

## Commands and SDK

`bb team --help` is the command inventory. All commands accept `--json`.

```bash
bb team initialize --json
bb team list --search "Name" --limit 20 --json
bb team resolve --name "Name" --limit 10 --json
bb team get --member MEMBER_ID --json
bb team create --actor ADMIN_ID --name "Name" --avatar fox --json
bb team update-self --member MEMBER_ID --name "New name" --avatar owl --json
bb team identity --member MEMBER_ID --json
bb team avatars --json
bb team timezone --timezone Asia/Shanghai --json
bb team activity --name "Name" --date today --json
bb team activity details --member MEMBER_ID --thread THREAD_ID --date today --json
bb team activity --member MEMBER_ID --from-date 2026-10-01 --to-date 2026-10-15 --limit 20 --max-chars 8000 --json
```

`src/contracts.ts` exports the typed `rpcContract`. Browser callers use
`useRpc<typeof rpcContract>()`; `src/client.ts` exports `createTeamClient`
for that transport and `createTeamSdkClient` for public `sdk.plugins.callRpc`.
Script callers can pass a public BB SDK with `plugins.callRpc` and its output
schema support. All write methods use the same member service.

For source-checkout scripts, use TypeScript with `npx tsx YOUR_SCRIPT.ts`
(the runtime Plugin SDK and script tooling are installed by `npm ci`).
Within another plugin, use its provided `bb.sdk`:

```ts
import { createTeamSdkClient } from './src/client.ts';
const team = createTeamSdkClient(bb.sdk);
const page = await team.list('Name', 20);
const profile = await team.get(memberId);
await team.updateSelf(memberId, 'New name', 'panda');
```

RPC methods are discoverable through BB's public plugin RPC discovery. No
extra member list, image bytes or tool collection is injected into agent
context. The short `team-activity` skill is loaded on demand. Activity also has
typed `team.activity(input)` and RPC `activity` entry points. Duplicate names
require explicit resolution. Date ranges use team timezone and exclusive end
dates; cursors freeze dates/timezone and must retain mode and filters. Follow
`nextCursor` as needed and report `hasMore`, `truncated`, live counts and retained
coverage. The character budget applies to complete serialized JSON, never a
partial JSON fragment; continuation starts after the last emitted item.

## Data and maintenance

Member data lives only in the plugin's own SQLite database. Migrations are
append-only. Disabling/reloading retains data; there is no member deletion,
merge, administrator transfer, thread ownership reassignment or implicit data
purge. Uninstall/data clearing follows BB's explicit host operations; the
plugin never removes team data as a shutdown side effect.

[AGENTS.md](AGENTS.md) identifies module ownership. [SECURITY.md](SECURITY.md)
describes the trusted boundary. Vendored UI retains BB's actual MIT license in
[licenses/](licenses/README.md); plugin code is copyright hxy91819.

CI downloads and verifies the pinned runtime and SDK, then performs dependency
installation, behavior tests, lint, formatting,
typecheck, plugin build, production dependency audit and secret scanning. The full development audit
also runs and currently reports known advisories bundled inside npm, which
upstream npm cannot auto-fix; this advisory step is visible and non-blocking. Verification
results and implementation choices are recorded in
[docs/verification.md](docs/verification.md).
