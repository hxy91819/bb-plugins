# ACP providers

First-party plugin for ACP (Agent Client Protocol) agent providers: Cursor,
opencode, omp, Grok Build, Hermes Agent, and DeepSeek Harness.

OpenCode Go usage appears under OpenCode in the Provider usage panel for the
selected machine. It reads the official Go endpoint using the machine's OpenCode
Console account or API credentials and reports the five-hour, weekly, and monthly
windows with their reset times. Sign in to Go in OpenCode on that machine.
The same data is available through `bb settings usage --machine <id> --json`
and `bb.sdk.system.usageLimits({ hostId, providerId: "acp-opencode" })`.
Other OpenCode providers and pay-as-you-go spending are not included.

Custom agents automatically expose tip forks when their ACP initialization
response advertises `session/fork`, and historical forks when it also advertises
`cursor-acp/checkpoint`; no extra fork setting is needed. Background
discovery runs on connected hosts, caches answers per launch configuration, and
refreshes changed launches. `bb thread fork` and the UI fork action become
available after successful discovery. Optional `"fork": "none"` disables forks;
`"fork": "tip"` limits forks to the conversation tip; `"fork": "checkpoint"`
declares historical support, checked by the probe and bridge. Select a saved
successful turn with `bb thread fork <id> --source-seq-end <seq>`. Checkpoints
preserve conversation state rather than files. See [Custom ACP configuration](#custom-acp-configuration) below for the configuration entrypoint.

Every agent it registers executes on the published ACP kit,
`@get-bb/plugin-sdk/provider-bridge/acp`. The host delegates all ACP execution
to that kit and adds only a read-only AGY usage maintenance handler.
The plugin uses only the public SDK; no file here imports a BB workspace package.

What lives here:

- `server.ts` — the plugin's runtime: it reconciles one registration per
  agent, from the shipped list (`src/known-agents.ts`) plus whatever the
  `customAgents` setting declares.
- `src/agents.ts` — the agent definition and the setting's schema, built out
  of the kit's own launch-spec schema so what the setting accepts is exactly
  what the bridge parses. The setting itself is a multi-line JSON field
  (`experimental_multiline`) whose description stays at two sentences; the
  field reference — required and optional fields, the replacement rule for a
  shipped agent's id, the `acp-<id>` provider id — is [Custom ACP configuration](#custom-acp-configuration) below.
- `src/configured-agents.ts` — resolving the setting's JSON into agent
  definitions, with a warning for each entry it cannot use.
- `src/declaration.ts` — one agent definition becomes one
  `bb.providers.register` declaration: ids, display names, icons,
  capabilities, and the bridge options it launches with (`acpLaunchSpec`, and
  `acpDialect` for the agents whose vendor side channels the kit reads).
- `src/host.ts` — the `bb.host` artifact, two surfaces in one file: the kit's
  bridge, with the AGY maintenance wrapper, and a host entry whose one RPC asks an agent what it
  supports on the machine it is installed on (`src/contract.ts`,
  `src/probe-capabilities.ts`).
- `icons/` — the provider logos, declared in `package.json` under
  `bb.branding.experimental_icons` so the packaged build ships them.

The kit itself, including the ACP wire schema, the delta translation, the
per-agent dialects and the bridge process, is `packages/provider-bridge-acp`.

## Custom ACP configuration

The BB-managed `customAgents` setting is the single configuration entrypoint:
`bb plugin config acp-extensions set customAgents '<JSON array>'`.
Preserve other entries when changing it. Each entry declares `id`, `displayName`,
`command`, optional `args`, `env`, `nativeSkillRoots`, `permissionCli`, `dialect`,
and `fork`. The provider ID remains `acp-<id>`.

Optional `permissionModes`, `reasoningLevels`, and `supportsServiceTier` keep the
provider's advertised controls aligned with its actual adapter. Defaults remain
Accept Edits/Full, the usual reasoning ladder, and Default/Fast tiers. A full-only
agent should explicitly declare `permissionModes: ["full"]` rather than advertise
an unenforced restriction.

AGY can use `dialect: "agy"` and `providerUsage: true`. Its ACP traffic still uses
the SDK's generic dialect. Its maintenance handler runs `AGY_BIN` from the launch
`env` (default `agy`) with `--print /usage`, on the selected machine, with bounded
output, timeout and shutdown cleanup. No machine path, account or executable-agent
registration is embedded in the quota dashboard. If a compatibility adapter is
needed (for example CodeBuddy's cancellation proxy), configure it as the launch
command; keep its executable separate from display plugins.

Native Codex/Claude/Pi providers, Account Pooler credentials/routing, and dashboard
preferences retain their respective BB configuration owners. This ACP setting
never modifies account-pool routing or selects a model-routing policy.

## DSH Approve for me

The existing `acp-dsh` provider offers `accept-edits`, `auto` (Approve for me), and `full`. Choose Approve for me in BB, pass `--permission-mode auto` to `bb thread spawn`, or use provider `acp-dsh` and `permissionMode: "auto"` through the SDK. No additional provider or account is created. Model routes and credentials stay in the existing DSH ACP profile.

`src/dsh-auto-review/bridge.ts` wraps the public shared ACP bridge only when the registered agent declares native DSH Auto review. The companion plugin is maintained in [hxy91819/dsh-plugins](https://github.com/hxy91819/dsh-plugins), pinned to an exact Git SHA in package-lock.json. Its generated isolated source comes from that package, so BB keeps no second implementation. The companion plugin sets only native `auto-review` model requests to reasoning effort `high`; execution and other model requests keep the DSH profile setting. Set `DSH_AUTO_REVIEW_REASONING_EFFORT` in the launch environment to choose another model-supported review effort, then restart/resume the DSH process. No review rules or permission decisions are replaced. The bridge writes a DSH overlay and a deployment copy of the companion plugin to private host data, mounts `@deepseek-ai/dsh-experimental-auto-review`, and selects the requested native preset for new/restored root sessions. The selected preset is pinned as `DSH_SESSION_PERMISSION_PRESET` in the launch environment so the shared bridge rebuilds and resumes the same DSH session on mode changes, including Full access → Auto → Full access. The native review package stays mounted across modes so recorded Auto sessions can be restored before selecting another preset. The shared bridge receives `accept-edits` internally, preserving user confirmation after a reviewer denial. Full access retains its non-reviewing execution policy; other providers retain their prior path.

Requires DSH 0.2.2-rc.1 with its Auto review package available to the profile loader. The installed distribution ships it. An ACP profile already mounting that package must remove the duplicate layer or use a separate profile. Missing native integration fails startup/session creation without falling back to Full access. DSH Auto review uses full host access after approval; direct Node side effects inside PTC remain outside its native review coverage.

For native process verification, set `DSH_NATIVE_TEST_COMMAND` to the installed DSH executable when running this plugin's test script through the pinned runtime. The tests isolate DSH_HOME and script only model outputs: real tool execution covers allow, deny, user approval/rejection, reviewer failure, malformed responses and session resume. CI without DSH runs the bridge tests and explicitly skips native process tests. Live BB approval and real model smokes are separate verification.
