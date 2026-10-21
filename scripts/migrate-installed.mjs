import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const names = process.argv.slice(2);
const supported = new Set(["team", "bookmarks", "acp-profile-icons"]);
if (names.length === 0 || names.some((name) => !supported.has(name)))
  throw new Error(
    "Usage: node scripts/migrate-installed.mjs team bookmarks acp-profile-icons",
  );
function cli(args) {
  try {
    const result = JSON.parse(
      execFileSync("bb", args, {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    if (result.ok === false) throw new Error("BB rejected the command");
    return result;
  } catch {
    throw new Error(`BB command failed: ${args.slice(0, 3).join(" ")}`);
  }
}
function restoreSettings(name, values) {
  for (const [key, value] of Object.entries(values))
    cli([
      "plugin",
      "config",
      name,
      "set",
      key,
      typeof value === "string" ? value : JSON.stringify(value),
      "--json",
    ]);
}
const installed = cli(["plugin", "list", "--json"]).plugins;
const cache = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "bb-plugin-migration",
);
await mkdir(cache, { recursive: true, mode: 0o700 });
const backup = await mkdtemp(join(cache, "collection-"));
for (const name of names) {
  const previous = installed.find((plugin) => plugin.id === name);
  if (!previous) throw new Error(`Plugin ${name} is not installed`);
  const source = cli(["plugin", "source", name, "--json"]);
  const directMove = previous.source.startsWith("path:");
  if (!directMove && !previous.enabled)
    throw new Error(
      `Enable ${name} before migrating its managed source so settings can be read.`,
    );
  const config = directMove
    ? { values: {} }
    : cli(["plugin", "config", name, "--json"]);
  const state = { source, enabled: previous.enabled, values: config.values };
  await writeFile(join(backup, `${name}.json`), JSON.stringify(state), {
    mode: 0o600,
  });
  const destination = join(root, "plugins", name);
  const before =
    name === "bookmarks" && previous.enabled
      ? cli(["bookmarks", "list", "--limit", "1", "--json"])
      : null;
  let changed = false;
  try {
    if (!directMove) {
      cli(["plugin", "remove", name, "--json"]);
      changed = true;
    }
    changed = true;
    const result = cli([
      "plugin",
      "install",
      `path:${destination}`,
      "--yes",
      "--json",
    ]);
    const current = result.plugin ?? result;
    if (
      !["running", "disabled", "needs-configuration"].includes(current.status)
    )
      throw new Error(`Plugin ${name} did not activate`);
    if (!directMove) {
      const values = { ...config.values };
      if (name === "bookmarks") delete values.language;
      restoreSettings(name, values);
    }
    if (!previous.enabled) cli(["plugin", "disable", name, "--json"]);
    if (before) {
      const after = cli(["bookmarks", "list", "--limit", "1", "--json"]);
      if (
        before.total !== after.total ||
        before.bookmarks[0]?.id !== after.bookmarks[0]?.id
      )
        throw new Error("Bookmark data changed during source migration");
    }
    const finalSource = cli(["plugin", "source", name, "--json"]);
    if (finalSource.requested !== `path:${destination}`)
      throw new Error(`Plugin ${name} did not move to the collection`);
    console.log(
      `${name}: migrated; configuration and storage identity retained`,
    );
  } catch (error) {
    if (changed) {
      try {
        const current = cli(["plugin", "list", "--json"]).plugins.find(
          (plugin) => plugin.id === name,
        );
        if (current && !directMove) cli(["plugin", "remove", name, "--json"]);
        cli(["plugin", "install", source.requested, "--yes", "--json"]);
        if (!directMove) restoreSettings(name, config.values);
        if (!previous.enabled) cli(["plugin", "disable", name, "--json"]);
      } catch {
        throw new Error(
          `${name}: rollback requires the private backup at ${backup}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}
console.log(`Private migration receipts: ${backup}`);
