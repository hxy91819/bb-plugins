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
