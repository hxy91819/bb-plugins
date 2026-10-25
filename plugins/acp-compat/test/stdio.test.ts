import { build } from "esbuild";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

let directory: string, runner: string, agent: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "acp-compat-transport-"));
  runner = join(directory, "runner.mjs");
  agent = join(directory, "agent.mjs");
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  await build({
    stdin: {
      contents:
        'import { runStdio } from "./src/stdio.ts"; runStdio("passthrough", process.execPath, process.argv.slice(2));',
      resolveDir: root,
    },
    outfile: runner,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  });
  await writeFile(
    agent,
    `
import { createInterface } from 'node:readline';
if (process.argv[2] === 'list') {
  console.log('Available models'); console.log(JSON.stringify(['one','two']));
} else {
  createInterface({input:process.stdin}).once('line', line => {
    const {id} = JSON.parse(line);
    const response = {jsonrpc:'2.0', id, result:{payload:'x'.repeat(2*1024*1024)}};
    process.stdout.write(JSON.stringify(response)+'\\n', () => process.exit(0));
  });
}
`,
  );
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("drains a large final response before exiting even when the upstream reader is paused", async () => {
  const child = spawn(process.execPath, [runner, agent], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "",
    error = "";
  child.stderr.on("data", (b) => {
    error += b;
  });
  child.stdout.pause();
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "example", params: {} }) +
      "\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  child.stdout.on("data", (b) => {
    output += b;
  });
  child.stdout.resume();
  const [code] = await once(child, "close");
  expect(error).toBe("");
  expect(code).toBe(0);
  const messages = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(messages).toHaveLength(1);
  expect(messages[0].id).toBe(1);
  expect(messages[0].result.payload).toHaveLength(2 * 1024 * 1024);
}, 10000);

it("preserves text and JSON model-discovery output without ACP envelopes", async () => {
  const child = spawn(process.execPath, [runner, agent, "list"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => {
    output += b;
  });
  const [code] = await once(child, "close");
  expect(code).toBe(0);
  expect(output).toBe('Available models\n["one","two"]\n');
});
