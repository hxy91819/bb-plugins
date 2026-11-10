import type { Message } from "../src/wire.js";
import { createInterface } from "node:readline";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
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

it.each(["exit", "channel-close"])(
  "settles outstanding DSH prompts and removes its overlay on %s",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "acp-dsh-lifecycle-"));
    const host = join(root, "host.mjs"),
      fake = join(root, "fake.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../host.ts", import.meta.url))],
      outfile: host,
      bundle: true,
      minify: true,
      format: "esm",
      platform: "node",
      target: "node22",
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      },
    });
    await writeFile(
      fake,
      `
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
const side = new Socket({fd:3, readable:true, writable:true});
const send = message => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\\n');
const notify = message => side.write(JSON.stringify({jsonrpc:'2.0',...message})+'\\n');
notify({method:'ready'});
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{agentInfo:{name:'fixture'}}});
 if(m.method==='fixture/overlay') send({id:m.id,result:{overlay:process.argv[process.argv.indexOf('--patch')+1]}});
 if(m.method==='session/prompt') {
  const params={sessionId:m.params.sessionId,messageId:'primary',text:m.params.prompt.map(b=>b.text).join('')};
  notify({method:'enqueued',params}); notify({method:'claimed',params});
  send({method:'fixture/primary-ready'});
 }
});
createInterface({input:side}).on('line',line=>{
 if(JSON.parse(line).method!=='steer')return;
 if(process.argv[2]==='exit') process.exit(17);
 else {side.destroy();setInterval(()=>{},1000);}
});
`,
    );
    const child = spawn(
      process.execPath,
      [host, "--acp-compat-proxy=dsh", process.execPath, fake, mode],
      {
        env: { ...process.env, TMPDIR: root },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = once(child, "close");
    let errors = "",
      overlay: string | undefined;
    const waiting = new Map<
      number,
      {
        resolve(value: Message): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    let resolvePrimary!: () => void;
    let rejectPrimary!: (error: Error) => void;
    const primary = new Promise<void>((resolve, reject) => {
      resolvePrimary = resolve;
      rejectPrimary = reject;
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const message = JSON.parse(line) as Message;
      if (message.method === "fixture/primary-ready") resolvePrimary();
      if (typeof message.id === "number") {
        const pending = waiting.get(message.id);
        if (pending) {
          waiting.delete(message.id);
          clearTimeout(pending.timer);
          pending.resolve(message);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const request = (id: number, method: string, params: object) =>
      new Promise<Message>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error("fixture timed out: " + errors));
        }, 5000);
        waiting.set(id, { resolve, reject, timer });
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    try {
      expect((await request(0, "initialize", {})).result?._meta).toEqual({
        midTurnSteering: true,
      });
      overlay = (await request(1, "fixture/overlay", {})).result
        ?.overlay as string;
      const first = request(2, "session/prompt", {
        sessionId: "s",
        prompt: [{ type: "text", text: "first" }],
      });
      const readyTimer = setTimeout(
        () => rejectPrimary(new Error("primary not claimed: " + errors)),
        4000,
      );
      await primary.finally(() => clearTimeout(readyTimer));
      const second = request(3, "session/prompt", {
        sessionId: "s",
        prompt: [{ type: "text", text: "second" }],
      });
      expect(
        (await Promise.all([first, second])).every(
          (message) => message.error?.code === -32000,
        ),
      ).toBe(true);
      await exited;
      await expect(access(dirname(overlay))).rejects.toThrow();
    } finally {
      child.kill("SIGKILL");
      await exited;
      lines.close();
      for (const pending of waiting.values()) clearTimeout(pending.timer);
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
