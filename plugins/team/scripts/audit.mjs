import { spawn } from "node:child_process";
import { once } from "node:events";
const env = { ...process.env };
// npm run promotes a user allow-scripts setting to env; npm 12 rejects that scope.
for (const key of Object.keys(env))
  if (key.toLowerCase() === "npm_config_allow_scripts") delete env[key];
const args = ["audit", "--audit-level=high"];
if (!process.argv.includes("--all")) args.push("--omit=dev");
const child = spawn("npm", args, { env, stdio: "inherit" });
const [code] = await once(child, "exit");
process.exitCode = code ?? 1;
