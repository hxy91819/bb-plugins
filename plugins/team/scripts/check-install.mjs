import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { node, cli, env, provenance } from "./runtime.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  dir = await mkdtemp(join(tmpdir(), "bb-team-install-"));
async function run(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    env,
  });
  const [code] = await once(child, "exit");
  if (code !== 0) throw Error(`${command} failed: ${code}`);
}
try {
  await run("git", ["clone", "--no-hardlinks", "--quiet", root, dir], root);
  await run(
    "npm",
    [
      "install",
      "--prefix",
      dir,
      "--ignore-scripts",
      "--omit=dev",
      "--omit=optional",
      "--no-fund",
      "--no-audit",
    ],
    dir,
  );

  await run(node, [cli, "plugin", "build", dir], dir);
  console.log(
    `PASS: clean committed Git checkout without generated files, production-only installation with scripts disabled, BB fork ${provenance.source} plugin build`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
