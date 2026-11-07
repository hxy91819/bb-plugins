# DSH Auto Review

This provider runs DSH's native experimental Auto review before tool execution. Allowed tools execute in DSH. A reviewer denial produces an ACP permission request that BB presents to the user; rejection or cancellation leaves the tool unexecuted, and reviewer failures do not execute it.

The provider id is `dsh-auto-review` and its only permission mode is `auto`. The original `acp-dsh` provider is unchanged. Model discovery and model/reasoning selection use the shared ACP bridge.

The host artifact writes an overlay and a companion DSH plugin to its private host-data directory. DSH boots the configured ACP profile with that overlay, preserving its model routes, credentials and session directory. The companion selects the native `auto` preset for new and restored root agents; delegated children retain DSH's own inherited policy. The shared BB bridge receives `accept-edits` internally so it forwards every DSH approval to the user instead of automatically approving it. BB continues to display `auto` on the thread.

Requires DSH 0.2.2-rc.1 with `@deepseek-ai/dsh-experimental-auto-review` available to the profile loader. The installed distribution ships it. An ACP profile already mounting that integration must remove that duplicate layer or use a separate profile. A missing integration or preset fails startup/agent creation; it never falls back to Full access. This does not add a sandbox: DSH Auto review uses full host access after approval, and direct Node side effects inside PTC remain outside DSH's native review coverage.

```sh
bb plugin install /path/to/dsh-auto-review
bb provider models dsh-auto-review --environment <environment-id> --json
bb thread spawn --project <project-id> --environment <environment-id> --provider dsh-auto-review --permission-mode auto --model '<model-id>' --prompt '<task>'
```

Use `bb plugin config dsh-auto-review set command /absolute/path/to/dsh` or `set profile acp` to change the execution host's DSH command/profile. These settings contain no credentials. The SDK equivalent is provider `dsh-auto-review` with `permissionMode: "auto"` in `threads.create`. Select DSH Auto Review in BB's provider picker for the UI workflow.

Run this package's typecheck, test, lint and build scripts through the collection's pinned runtime and host resource isolation runner. Unit tests cover mode translation; the native fixture smoke covers allowed, denied, failed and restored sessions without model credentials. A live model smoke is separate evidence.
