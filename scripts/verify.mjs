import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const collection = JSON.parse(
  await readFile(join(root, ".bb/plugins.json"), "utf8"),
);
const requested = process.argv[2];
const tasks = requested ? [requested] : ["typecheck", "test", "build"];
const runtime = process.env.BB_PLUGINS_RUNTIME_DIR;
const supply = JSON.parse(
  await readFile(join(root, "bb-runtime.json"), "utf8"),
);
const env = { ...process.env };
if (runtime) {
  const release = JSON.parse(
    await readFile(join(runtime, "release.json"), "utf8"),
  );
  if (release.source !== supply.source || release.tag !== supply.tag)
    throw new Error(`Use the documented BB ${supply.tag} runtime.`);
  env.PATH = `${join(runtime, "bin")}:${env.PATH ?? ""}`;
  delete env.BB_CLI;
  delete env.BB_CLI_REEXEC;
}
const failures = [];
for (const plugin of collection.plugins) {
  const cwd = join(root, plugin.source);
  const manifest = JSON.parse(
    await readFile(join(cwd, "package.json"), "utf8"),
  );
  for (const task of tasks) {
    if (task === "test" && !manifest.scripts?.test) continue;
    if (task === "lint" && !manifest.scripts?.lint) continue;
    if (task === "format" && !manifest.scripts?.["format:check"]) continue;
    const args =
      task === "ci"
        ? ["ci", "--no-audit", "--no-fund", "--legacy-peer-deps"]
        : task === "audit"
          ? manifest.scripts?.audit
            ? ["run", "audit"]
            : ["audit", "--audit-level=high"]
          : task === "install"
            ? ["install", "--no-audit", "--no-fund", "--legacy-peer-deps"]
            : ["run", task === "format" ? "format:check" : task];
    const command =
      task === "build" ? (runtime ? join(runtime, "bin", "bb") : "bb") : "npm";
    const commandArgs = task === "build" ? ["plugin", "build", cwd] : args;
    console.log(`${plugin.name}: ${command} ${commandArgs.join(" ")}`);
    const result = spawnSync(command, commandArgs, {
      cwd,
      env,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      failures.push(`${plugin.name}: ${task} exited ${result.status ?? 1}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
