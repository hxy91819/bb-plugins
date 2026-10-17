import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const directory = process.env.BB_TEAM_RUNTIME_DIR;
if (!directory)
  throw Error(
    "Set BB_TEAM_RUNTIME_DIR to the compatible BB fork archive's extracted runtime; stock bb-app is not supported.",
  );
export const runtime = resolve(directory);
export const provenance = JSON.parse(
  readFileSync(join(runtime, "release.json"), "utf8"),
);
const supply = JSON.parse(
  readFileSync(new URL("../release/bb-supply.json", import.meta.url), "utf8"),
);
if (provenance.source !== supply.source)
  throw Error(`Team requires BB source ${supply.source} (${supply.tag}).`);
export const node = join(runtime, "bin/node");
export const cli = join(runtime, "node_modules/bb-app/dist/bb.js");
export const server = join(runtime, "node_modules/bb-app/dist/bb-server.js");
for (const file of [node, cli, server])
  if (!existsSync(file)) throw Error(`Missing runtime entry: ${file}`);
if (!provenance.node.startsWith("v24."))
  throw Error("Team verification requires matching Node 24.");
const config = mkdtempSync(join(tmpdir(), "bb-team-npm-"));
writeFileSync(join(config, "userconfig"), "");
writeFileSync(join(config, "globalconfig"), "");
process.on("exit", () => rmSync(config, { recursive: true, force: true }));
export const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (
    /^npm_config_(allow_scripts|userconfig|globalconfig)$/i.test(key) ||
    [
      "BB_CLI",
      "BB_CLI_REEXEC",
      "BB_THREAD_ID",
      "BB_PROJECT_ID",
      "BB_ENVIRONMENT_ID",
    ].includes(key)
  )
    delete env[key];
}
Object.assign(env, {
  PATH: `${join(runtime, "bin")}:${env.PATH ?? ""}`,
  BB_CLI: join(runtime, "node_modules/bb-app/host-daemon/dist/bb"),
  NPM_CONFIG_USERCONFIG: join(config, "userconfig"),
  NPM_CONFIG_GLOBALCONFIG: join(config, "globalconfig"),
});
