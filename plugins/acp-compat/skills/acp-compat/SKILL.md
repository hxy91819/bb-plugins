---
name: acp-compat
description: Prepare or troubleshoot plugin-managed ACP protocol adapters when explicitly requested; ordinary ACP provider settings belong to the ACP provider plugin.
disable-model-invocation: true
triggers: [user]
---

# ACP compatibility launches

Discover the execution host with `bb machine list --json`, then use
`bb acp-compat launch --help` for the launch helper. Supply the original agent's
ACP launch JSON and select `codebuddy` or `passthrough`. The returned command
executes on that host and uses its persistent plugin runner.

The helper prepares the runner and returns launch fields; it does not update
provider settings. Apply returned fields within the user's authorized task,
preserving the provider ID, unrelated agents, permissions and skill roots.
For ACP Extensions, preserve the full `customAgents` array when updating it.
Keep a private copy of the previous launch for rollback.

After a plugin update or host move, prepare the launch again. Verify provider
health and models, same-run injection receipts, Stop and a subsequent normal
prompt. Acceptance of a native steer request alone is insufficient evidence
that the model received it. Keep credentials and live transcripts out of source
control.
