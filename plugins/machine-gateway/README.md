# Machine Gateway

Connect BB execution machines through a self-hosted HTTPS reverse proxy. Machines
do not need BB Connect or a VPN client; only the gateway needs network access to
the BB server. This headless plugin uses the public server-access API and works
with the built-in Machines UI, SDK and `bb machine` commands.

## Configure

```sh
bb plugin install git:https://github.com/hxy91819/bb-plugins.git@main --plugin machine-gateway --yes
bb plugin config machine-gateway set gatewayUrl https://gateway.example.com
bb settings general defaultMachineAccess machine-gateway
bb settings general machineServerUrl https://gateway.example.com
```

Configure the gateway before creating machines. Permit enrollment requests to
`/install.sh` and `/install.ps1` carrying `X-BB-Enrollment` to reach BB; BB validates
the enrollment credential and returns a private bootstrap containing the machine's
gateway credential. Invalid enrollment returns 403. Never cache these responses.

For other requests carrying `X-BB-Gateway-Machine`, use a private upstream
`forward_auth` call to `/api/v1/plugins/machine-gateway/http/verify`. Forward the
original credential header to that endpoint and proxy only successful responses.
Keep `Authorization` and WebSocket upgrades intact. Requests without a machine
credential must retain your existing browser authentication. Do not expose the
BB API without either form of authentication, and do not trust header presence
without verification. Strip incoming Tailscale identity headers before proxying.
Remove `Upgrade` and `Connection` only from the verifier subrequest, so a daemon's
WebSocket handshake does not turn that HTTP verification into a WebSocket route.

After verification, overwrite `X-BB-Gate-Auth` with `machine` and remove
`X-BB-Gate-Machine-Id`, so core retains its restrictions on machine management.
The exceptions are `/internal/hosts/enroll` and `/internal/session/open`: remove
both headers there, since those routes bind a BB Connect identity when marked as
a gate machine; this self-hosted transport has none. BB still validates the
one-time enrollment key or daemon host key, respectively.
Remove both headers from installer requests too. These headers are part of the
current BB gate transport contract; validate this boundary when upgrading BB.

Redact `X-BB-Enrollment`, `X-BB-Gateway-Machine`, `Authorization` and cookies from
gateway logs, including debug logs. Exclude query strings, which can carry tokens.

Create a manual machine in Settings → Machines or with
`bb machine create --provider manual`, and run its generated command on the
target. The installer fetches the server's own fork host artifact. The persisted
gateway header is used by the daemon, its CLI authentication proxy, and provider
server URLs, including Account Pooler. Provider CLIs still need installation.

## Credentials and trust

Each machine receives an independent HMAC-SHA256 credential. The signing key is
stored as a BB secret setting; only non-secret grant nonces are in the plugin's
SQLite database. Tokens are not printed by this plugin. Acquisition is idempotent,
and removal releases the grant. Verification also rejects removing or destroyed
machines. Reacquiring after release issues a different credential. Reload keeps
existing grants valid. Replacing the signing key invalidates every old credential.

Enrolled machines are trusted operators of the BB instance, like BB Connect
machines: their gateway credential permits the BB HTTP API, not only one project.
This plugin is not a per-user or per-project authorization system. Daemon and
Account Pooler endpoints retain their own credentials as well. Revocation rejects
new HTTP requests and connections; it does not itself terminate existing streams.

The URL must be an HTTPS origin. Availability reports configured state, not proof
of reachability from a target. If the gateway or verifier fails, authentication
fails closed. An empty URL makes the provider unavailable. Disabled or uninstalled
plugins cannot authorize traffic. Moving an existing machine to another URL or
signing key requires reconnecting it from Machines settings.

## Development

```sh
npm ci
npm run typecheck
npm test
bb plugin build .
```

Use the resource isolation runner supplied by your host. Tests exercise the real
plugin through the public SDK harness and its SQLite storage.
