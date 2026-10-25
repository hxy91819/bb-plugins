import { fileURLToPath } from "node:url";
import { copyFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./src/contract.js";
import { wrapLaunch } from "./src/launch.js";
import { adapterIdSchema } from "./src/adapters/index.js";
import { runStdio } from "./src/stdio.js";

const mode = process.argv[2];
if (mode?.startsWith("--acp-compat-proxy=")) {
  const adapter = adapterIdSchema.parse(
    mode.slice("--acp-compat-proxy=".length),
  );
  const command = process.argv[3];
  if (!command)
    throw new Error("ACP compatibility requires a downstream command");
  runStdio(adapter, command, process.argv.slice(4));
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async prepareLaunch(input, context) {
      const entry = join(context.experimental_paths.dataDir, "runner.mjs");
      const temporary = entry + "." + randomUUID();
      try {
        await copyFile(fileURLToPath(import.meta.url), temporary);
        context.signal.throwIfAborted();
        await rename(temporary, entry);
      } finally {
        await rm(temporary, { force: true });
      }
      return wrapLaunch(input.launch, input.adapter, process.execPath, entry);
    },
  },
});
