# ACP Compatibility

Optional ACP protocol adapters for existing BB providers. This plugin supplies a
host-local launch command; the existing ACP provider still owns registration,
models, permissions, skills and BB's shared bridge. No BB core or first-party
ACP plugin changes are required.

## Install and prepare a launch

```sh
bb plugin install git:https://github.com/hxy91819/bb-plugins.git@main --plugin acp-compat
bb machine list --json
bb acp-compat launch --host <host-id> --adapter codebuddy --launch '{"displayName":"CodeBuddy","command":"codebuddy","args":["--acp"],"env":{}}' --json
```

The command returns a full ACP launch specification. It prepares a standalone
runner in that plugin's persistent directory on the selected host. Node and
runner paths come from the host rather than the server. Execution does not use
a shell. Re-run launch preparation after updating this plugin or moving to a
new execution host.

Use the returned `command`, `args`, and other launch fields in the existing
agent's configuration. Preserve its provider ID and all unrelated agents and
fields. For the ACP Extensions plugin the setting is `customAgents`, configured
with `bb plugin config acp-extensions set customAgents '<JSON array>'`.
The launch helper does not change those settings itself. The original direct
agent command should be the downstream executable; remove a replaced legacy
compatibility wrapper from the launch rather than nesting wrappers.

The same operation is available as this plugin's public `prepareLaunch` RPC,
using the exported contract in `src/contract.ts`. Its input is
`{ hostId, adapter, launch }`; the result is the wrapped launch specification.
Model-discovery arguments and permission argument insertion positions are
translated along with the command. The provider's other options stay with its
current owner.

## Adapters

| Adapter       | Behavior                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passthrough` | Preserve the agent's ACP behavior and declared capabilities, including concurrent prompts.                                                        |
| `codebuddy`   | Adapt concurrent prompt steering to CodeBuddy's dedicated `session/steer` extension; serialize ordinary prompts and retain cancellation recovery. |

The generic transport and lifecycle implementation is `src/proxy.ts`. An
adapter defines extension probing, input eligibility, request construction,
admission interpretation and insertion receipts in `src/adapters/`. Vendor
method names and metadata are confined to that adapter.

CodeBuddy support is verified without invoking a model: after initialize the
adapter sends `session/steer` with missing parameters and checks the extension's
specific invalid-parameters response. Missing or timed-out support advertises
`midTurnSteering=false`; the existing BB interrupt fallback remains available.
This is a provider extension, not a universal ACP steering method.

For an active run, ordinary text steering is bound to its observed request ID.
Success requires both admission and a matching user-message insertion receipt
from that run. It does not cancel the current tool. Commands, images and inputs
whose run ownership is not yet known request interrupt delivery. An ambiguous
admission timeout or a missing insertion receipt fails visibly instead of
claiming success or replaying an input that might already have executed.

Explicit `session/cancel` settles waiting inputs, retries missed active cancels
and maintains a quiet barrier before replacement prompts. As with the original
agent protocol, cancelling an executing tool depends on the agent honoring
cancel; cancellation requests are retried at most twenty times. Process exit
settles all outstanding requests. Ordinary queueing remains owned by BB.

## Compatibility and verification

The dependency and lockfile pin the collection's published fork SDK baseline
`fork-v0.46.0-20261016.6` (source
`47d099969891cab18398dc4064e836040159e6a3`). Live validation also uses BB
`fork-v0.46.1-20261024.1` and CodeBuddy 2.175.0. No credentials, user transcripts
or machine paths belong in the source repository.

Run `npm ci --allow-remote=all`, then the package's typecheck, test, lint,
format and build scripts. Follow the collection's resource-isolation convention
for verification. Unit tests exercise receipt/run matching, admission races,
multiple steers, unsupported inputs, cancellation barriers, retries and process
exit. Live acceptance should verify the current tool completes, the correction
is inserted in the same run, the original branch is skipped, and a single BB
turn completes without cancel. A second run should verify explicit Stop and a
subsequent normal prompt.

To roll back, restore the saved original agent launch. This plugin owns no
providers, user credentials or conversation data.
