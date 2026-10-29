import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export async function createRuntimeToolchain() {
  const env = { ...process.env };
  const runtime = process.env.BB_PLUGINS_RUNTIME_DIR;
  if (!runtime)
    throw new Error(
      "Set BB_PLUGINS_RUNTIME_DIR to the complete pinned runtime.",
    );
  const directory = resolve(runtime);
  const supply = JSON.parse(
    await readFile(new URL("../bb-runtime.json", import.meta.url), "utf8"),
  );
  const release = JSON.parse(
    await readFile(join(directory, "release.json"), "utf8"),
  );
  if (release.source !== supply.source || release.tag !== supply.tag)
    throw new Error(`Use the documented BB ${supply.tag} runtime.`);
  const node = join(directory, "bin/node");
  const bb = join(directory, "bin/bb");
  const npm = join(directory, "node_modules/npm/bin/npm-cli.js");
  const npx = join(directory, "node_modules/npm/bin/npx-cli.js");
  for (const [name, path, mode] of [
    ["Node", node, constants.X_OK],
    ["BB", bb, constants.X_OK],
    ["npm", npm, constants.R_OK],
    ["npx", npx, constants.R_OK],
  ]) {
    try {
      await access(path, mode);
    } catch {
      throw new Error(
        `Pinned runtime ${name} is missing or inaccessible: ${path}`,
      );
    }
  }
  const shim = await mkdtemp(join(tmpdir(), "bb-collection-toolchain-"));
  try {
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    for (const [name, entry] of [
      ["npm", npm],
      ["npx", npx],
    ])
      await writeFile(
        join(shim, name),
        `#!/bin/sh\nexec ${quote(node)} ${quote(entry)} "$@"\n`,
        { mode: 0o755 },
      );
    env.PATH = `${shim}:${join(directory, "bin")}:${env.PATH ?? ""}`;
    env.npm_execpath = npm;
    env.npm_node_execpath = node;
    delete env.BB_CLI;
    delete env.BB_CLI_REEXEC;
    return {
      env,
      node,
      bb,
      npm,
      npx,
      dispose: () => rm(shim, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(shim, { recursive: true, force: true });
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const toolchain = await createRuntimeToolchain();
  try {
    const [tool, ...args] = process.argv.slice(2);
    if (!["npm", "npx", "node", "bb"].includes(tool))
      throw new Error("Usage: runtime-toolchain.mjs npm|npx|node|bb [args...]");
    const result = spawnSync(
      tool === "bb" ? toolchain.bb : toolchain.node,
      tool === "npm" || tool === "npx" ? [toolchain[tool], ...args] : args,
      { env: toolchain.env, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    await toolchain.dispose();
  }
}
