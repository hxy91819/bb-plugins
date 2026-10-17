import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { node, cli, env, provenance } from "./runtime.mjs";
console.log(`Building with BB source ${provenance.source}, ${provenance.node}`);
const child = spawn(
  node,
  [cli, "plugin", "build", fileURLToPath(new URL("../", import.meta.url))],
  { env, stdio: "inherit" },
);
const [code] = await once(child, "exit");
process.exitCode = code ?? 1;
