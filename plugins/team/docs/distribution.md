# Historical v0.2.0 release artifacts

For new installations and existing-source migration, use the [collection installation guide](../../../README.md) and [data-preserving migration](../../../docs/migration.md). The fixed v0.2.0 artifacts below remain available in the archived original repository.

## Supply status

The compatible [BB release](https://github.com/hxy91819/bb/releases/tag/fork-v0.46.0-20261014.3)
is `fork-v0.46.0-20261014.3`, source
`9ddb184943a3ce7e5820fb1d141c782c958af521`.
[release/bb-supply.json](../release/bb-supply.json) records verified runtime and
SDK SHA256 checksums and the SDK integrity used by the lockfile.

The SDK URL is
`https://github.com/hxy91819/bb/releases/download/fork-v0.46.0-20261014.3/bb-plugin-sdk-fork-v0.46.0-20261014.3.tgz`.
It remains `@get-bb/plugin-sdk` version `0.6.37`, but comes from that BB source;
the npm registry's same version does not provide the fork APIs. package.json
and package-lock.json pin this URL and its measured integrity. No local
`file:` dependency is published.

## Complete archive installation

The plugin release provides `bb-team-v0.2.0.tar.gz`, its `.tar.gz.sha256`,
and a JSON source/checksum receipt. Download all three from the same plugin
release:

```bash
PLUGIN_TAG='v0.2.0'
ARCHIVE="bb-team-${PLUGIN_TAG}.tar.gz"
BASE_URL="https://github.com/hxy91819/bb-team/releases/download/${PLUGIN_TAG}"
curl --fail --location "$BASE_URL/$ARCHIVE" --output "$ARCHIVE"
curl --fail --location "$BASE_URL/$ARCHIVE.sha256" --output "$ARCHIVE.sha256"
curl --fail --location "$BASE_URL/bb-team-${PLUGIN_TAG}.json" --output "bb-team-${PLUGIN_TAG}.json"
sha256sum --check "$ARCHIVE.sha256"
mkdir "bb-team-${PLUGIN_TAG}-install"
tar -xzf "$ARCHIVE" -C "bb-team-${PLUGIN_TAG}-install"
PLUGIN_DIR="$(pwd)/bb-team-${PLUGIN_TAG}-install/bb-team-${PLUGIN_TAG}"
```

On macOS, use `shasum -a 256 -c "$ARCHIVE.sha256"` for the checksum step.
Check the receipt's BB tag/source against the matching BB runtime's
`release.json`. Install the runtime archive for your platform using its own
release instructions; do not replace it with stock BB 0.46.0.

The plugin archive contains package.json/lockfile, server/app/source entries,
compiled `dist`, the 20 ordinary avatar PNGs, dedicated Admin PNG and their manifest, the on-demand
skill, and project/vendored/dependency licenses. It contains no node_modules,
credentials or machine-specific source maps. The JSON receipt identifies the
plugin commit and compatible BB source. The full dependency license texts are
under `licenses/dependencies/`, with an inventory at
`licenses/dependencies.json`.

Use the matching runtime's Node and CLI, and explicitly choose the target BB
instance:

```bash
BB_RUNTIME='/absolute/path/to/the/matching/bb-runtime'
export PATH="$BB_RUNTIME/bin:$PATH"
export BB_CLI="$BB_RUNTIME/bin/bb"
export BB_SERVER_URL='http://127.0.0.1:YOUR_CHOSEN_PORT'
(cd "$PLUGIN_DIR" && npm ci --ignore-scripts --omit=dev --omit=optional)
"$BB_RUNTIME/bin/bb" plugin install "path:$PLUGIN_DIR"
```

BB rebuilds the source during directory installation. Bundled `dist` is a
traceable build output, not a build-free loader contract. A Release ZIP or
`.tar.gz` URL is **not** a direct `bb plugin install` source. Keep the extracted
directory after installing: local path installations continue to use it.

## Git installation

Use the same compatible BB runtime and an actual published plugin tag:

```bash
PLUGIN_TAG='v0.2.0'
"$BB_RUNTIME/bin/bb" plugin install "git:https://github.com/hxy91819/bb-team.git@${PLUGIN_TAG}"
```

A commit SHA can replace the tag. A bare repository URL tracks its default
branch; a fixed tag/commit records the version you chose. Managed Git
installation installs production dependencies with lifecycle scripts disabled
and rebuilds the plugin. The formal SDK pin is available even when an
installation omits development dependencies.

## Creating artifacts

From a clean committed checkout with the compatible runtime selected:

```bash
export BB_TEAM_RUNTIME_DIR="$BB_RUNTIME"
node scripts/package-release.mjs '/new/output/directory'
```

The script copies source from the exact Git commit, installs locked production
dependencies, builds using that runtime, collects dependency license texts,
and writes one complete archive, checksum and source receipt. It never pushes,
tags or creates a GitHub Release. Preserve these exact bytes for publication.

Before formal supply is ready, `--candidate` creates a clearly named local
candidate archive with `candidate: true` and no purported verified SDK URL or
integrity. CI uses `scripts/fetch-supply.mjs` and the committed supply record;
it refuses to download while that record is pending. Once verified, CI
checks downloaded checksums and runtime provenance, installs the URL-pinned
SDK through npm ci, runs checks/audits and uploads the complete plugin archive
as a workflow artifact. Publishing and public readback remain separate steps.
