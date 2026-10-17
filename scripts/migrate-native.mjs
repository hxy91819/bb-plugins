import { isDeepStrictEqual } from "node:util";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const name = process.argv[2];
if (process.argv.length !== 3 || !["thread-list", "acp"].includes(name))
  throw new Error("Usage: node scripts/migrate-native.mjs thread-list|acp");
function cli(args) {
  try {
    const result = JSON.parse(
      execFileSync("bb", [...args, "--json"], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    if (result.ok === false)
      throw new Error(`BB rejected ${args.slice(0, 3).join(" ")}`);
    return result;
  } catch {
    throw new Error(`BB command failed: ${args.slice(0, 3).join(" ")}`);
  }
}
const previousId = name === "acp" ? "provider-acp" : "thread-list";
const nextId = name === "acp" ? "acp-extensions" : "thread-list-extras";
const installed = cli(["plugin", "list"]).plugins;
if (!installed.find((plugin) => plugin.id === previousId)?.enabled)
  throw new Error(
    `The original ${previousId} must be enabled to read its configuration.`,
  );
if (installed.some((plugin) => plugin.id === nextId))
  throw new Error(
    `${nextId} is already installed; its existing configuration must be reconciled first.`,
  );
if (name === "acp") {
  const threads = [
    ...cli(["thread", "list", "--include-hidden"]),
    ...cli(["thread", "list", "--include-hidden", "--archived"]),
  ];
  if (
    threads.some(
      (thread) =>
        thread.providerId.startsWith("acp-") &&
        !["idle", "error"].includes(thread.status),
    )
  )
    throw new Error(
      "Wait for ACP threads to become idle before changing their provider plugin.",
    );
}
const values =
  name === "acp"
    ? cli(["plugin", "config", previousId]).values
    : cli([previousId, "prefs", "list"]);
const selection =
  name === "thread-list"
    ? cli(["settings", "ui", "get", "sidebar.threadListProvider"]).value
    : null;
const cache = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "bb-plugin-migration",
);
await mkdir(cache, { recursive: true, mode: 0o700 });
const receipt = await mkdtemp(join(cache, `${name}-`));
await writeFile(
  join(receipt, "before.json"),
  JSON.stringify({ previousId, nextId, values, selection }),
  { mode: 0o600 },
);
const literal = (value) =>
  typeof value === "string" ? value : JSON.stringify(value);
try {
  if (name === "acp") cli(["plugin", "disable", previousId]);
  const destination = join(
    root,
    "plugins",
    name === "acp" ? "provider-acp" : name,
  );
  const result = cli(["plugin", "install", `path:${destination}`, "--yes"]);
  if ((result.plugin ?? result).status !== "running")
    throw new Error(`${nextId} failed to start`);
  const expected = {};
  for (const [key, oldValue] of Object.entries(values)) {
    const value =
      name === "thread-list" && key === "rowActions"
        ? oldValue.map((action) =>
            action === "thread-list/move" ? "thread-list-extras/move" : action,
          )
        : oldValue;
    expected[key] = value;
    cli(
      name === "acp"
        ? ["plugin", "config", nextId, "set", key, literal(value)]
        : [nextId, "prefs", "set", key, literal(value)],
    );
  }
  const actual =
    name === "acp"
      ? cli(["plugin", "config", nextId]).values
      : cli([nextId, "prefs", "list"]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    for (const key of Object.keys(expected))
      if (!isDeepStrictEqual(actual[key], expected[key]))
        throw new Error(`Configuration ${key} did not migrate`);
  }
  if (name === "thread-list") {
    if (["__automatic__", "thread-list/thread-list"].includes(selection))
      cli([
        "settings",
        "ui",
        "set",
        "sidebar.threadListProvider",
        "thread-list-extras/thread-list",
      ]);
    cli(["plugin", "disable", previousId]);
  }
  console.log(
    `${previousId} migrated to ${nextId}; original configuration retained. Private receipt: ${receipt}`,
  );
} catch (error) {
  try {
    if (cli(["plugin", "list"]).plugins.some((plugin) => plugin.id === nextId))
      cli(["plugin", "remove", nextId]);
    cli(["plugin", "enable", previousId]);
    if (name === "thread-list")
      cli([
        "settings",
        "ui",
        "set",
        "sidebar.threadListProvider",
        literal(selection),
      ]);
  } catch {
    throw new Error(`Rollback requires the private receipt at ${receipt}`, {
      cause: error,
    });
  }
  throw error;
}
