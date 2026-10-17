---
name: acp-provider
description: "Configure or troubleshoot ACP agent discovery, custom models, skills, forks, and compaction in BB."
---

# ACP providers

Known agents can be discovered automatically when their CLI is installed on the
host: `opencode`, `omp`, `grok`, `hermes`, and `dsh` appear as `acp-opencode`,
`acp-omp`, `acp-grok`, `acp-hermes-agent`, and `acp-dsh`. Inspect the target host's
catalog with
`bb provider list` and `bb provider models <provider-id>` using its environment
or machine selector.

To hide a detected ACP agent, use `bb provider disable acp-opencode`, or Disable
on Settings → Providers. Restore it with `bb provider enable acp-opencode`.
This leaves other ACP agents and the host CLI intact. Disabled agents skip
background capability probing. `bb provider list --all` includes disabled agents.

Cursor project skills come from `.cursor/skills`, which can link to
`.agents/skills`. BB lists these linked skills as read-only under `cursor-project`.

ACP agents may reject unlisted model IDs. OpenCode requires models in its own
configuration; BB discovers them there. OpenCode agents are session modes, not
models selectable through BB's model field. Grok Build advertises models and
`thought_level` options over ACP, so the picker follows the connected agent
(including `xhigh` on grok-4.6).

BB launches OpenCode sessions with `OPENCODE_CLIENT=acp` and
`OPENCODE_ENABLE_QUESTION_TOOL=false`, overriding inherited and custom launch
values. Native questions have no ACP interaction handler in BB; agents use the
ask-user-question plugin’s `AskUserQuestion` tool instead. This also applies to
custom agents with `dialect: "opencode"` and does not change OpenCode config files.

OpenCode and Grok ACP support the core `bb thread compact` command; Cursor ACP
does not expose compatible compaction. Check the actual agent's capabilities
before attempting provider-specific recovery.

OpenCode Go subscription usage is available in Provider usage when the selected
machine has OpenCode installed and a Go subscription. Sign in to Go in OpenCode
on that machine, then refresh its OpenCode tab. Verify with
`bb settings usage --machine <id-or-name> --json`; the SDK equivalent is
`bb.sdk.system.usageLimits({ hostId, providerId: "acp-opencode" })`.
BB reports Go's five-hour, weekly, and monthly usage and reset times, not local
session token totals or other OpenCode providers' subscriptions.

The collector checks `OPENCODE_API_KEY`, then the active official Console account
and organization in `$XDG_DATA_HOME/opencode/opencode.db`, then active v2
`credential` table API keys or official Console OAuth credentials
(`opencode-go` before `opencode`), then
`OPENCODE_AUTH_CONTENT` or `$XDG_DATA_HOME/opencode/auth.json`.
The default data directory is `~/.local/share/opencode`. Database storage is read
only; expired Console sessions must be refreshed by OpenCode. V2 OAuth requires
the device login method and account/organization metadata for the official
Console server. API-key login
prefers the `opencode-go` credential and accepts the shared `opencode` credential
when Go is subscribed. Custom launch `env` values take precedence over the host
environment. A custom OpenCode wrapper must declare
`dialect: "opencode"` and `providerUsage: true` to expose its usage.
Missing credentials, rejected keys, and collection errors remain unavailable
states rather than zero usage. Never print API keys when diagnosing setup.

Custom ACP agents are configured with `bb plugin config acp-extensions set
customAgents '[...]'`. Preserve other entries when updating the list. Omit
`fork` to discover the agent's capabilities on connected hosts: `session/fork`
enables tip forks, and its `cursor-acp/checkpoint` metadata enables historical
forks. Optional `"fork": "none"` disables forks; `"fork": "tip"` limits them
to the conversation tip; `"fork": "checkpoint"` declares historical support.
The probe and bridge check the agent's capabilities. Older host probes report
only tip support; an explicit checkpoint declaration is preserved until the
bridge verifies the agent at execution.

Use `bb thread fork <thread-id>` or the UI fork action. Select a saved successful
turn boundary with `bb thread fork <id> --source-seq-end <seq>` or SDK
`threads.fork({ sourceThreadId, sourceSeqEnd, ... })`. Earlier turns without a
saved checkpoint cannot be reconstructed; checkpoints preserve conversation
state rather than reverting files. The adapter must copy independent session
state, not just return a new empty ID.

Launch changes are re-probed on the next host poll; reload the ACP providers
plugin after upgrading an agent without changing its launch. Any supporting
connected host enables automatic forks in the global provider catalog; the
bridge verifies the chosen host at execution.
