import { build } from "esbuild";
import { selectorSource } from "@hxy91819/dsh-plugins/session-permission/source";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { wrapLaunch } from "../src/launch.js";
import { messageSchema, type Message } from "../src/wire.js";

const command = process.env.DSH_STEERING_TEST_COMMAND;
if (process.env.CI && !command)
  throw new Error(
    "CI requires DSH_STEERING_TEST_COMMAND for the native DSH regression",
  );
it.skipIf(!command)(
  "steers an unpatched DSH process inside its running turn, cancels and recovers",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-steering-native-"));
    const work = join(root, "work");
    await mkdir(work);
    const runner = join(root, "runner.mjs");
    await build({
      entryPoints: [
        join(dirname(dirname(fileURLToPath(import.meta.url))), "host.ts"),
      ],
      outfile: runner,
      bundle: true,
      minify: true,
      format: "esm",
      platform: "node",
      target: "node22",
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      },
    });
    const patch = join(root, "fixture.yml"),
      evidence = join(root, "events.jsonl");
    const selector = join(root, "permission.mjs");
    await writeFile(selector, selectorSource);
    await writeFile(
      patch,
      JSON.stringify([
        {
          insert: [
            {
              id: "native-auto-review",
              name: "@deepseek-ai/dsh-experimental-auto-review",
            },
            { id: "native-permission", name: selector },
            {
              id: "fixture-model",
              name: fileURLToPath(
                new URL("./fixtures/dsh-model.mjs", import.meta.url),
              ),
            },
          ],
        },
      ]),
    );
    const launch = wrapLaunch(
      {
        displayName: "DSH",
        command: command!,
        args: ["--profile", "acp", "--patch", patch],
        env: {},
      },
      "dsh",
      process.execPath,
      runner,
    );
    const child = spawn(launch.command, launch.args, {
      env: {
        ...process.env,
        DSH_HOME: join(root, "home"),
        DSH_STEERING_EVIDENCE: evidence,
        DSH_SESSION_PERMISSION_PRESET: "auto",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = once(child, "close");
    let stderr = "",
      serial = 0;
    const replies = new Map<number, (m: Message) => void>();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const parsed = messageSchema.safeParse(JSON.parse(line));
      if (parsed.success && typeof parsed.data.id === "number") {
        replies.get(parsed.data.id)?.(parsed.data);
        replies.delete(parsed.data.id);
      }
    });
    child.stderr.on("data", (b) => {
      stderr += b;
    });
    const send = (method: string, params: object) =>
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
      );
    const request = (method: string, params: object) =>
      new Promise<Message>((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => {
          replies.delete(id);
          reject(new Error("Request timed out: " + method + ": " + stderr));
        }, 20000);
        replies.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    const waitFile = async (path: string) => {
      const deadline = Date.now() + 20000;
      for (;;) {
        try {
          await access(path);
          return;
        } catch {
          if (Date.now() >= deadline)
            throw new Error(`Timed out waiting for ${path}: ${stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    try {
      const init = await request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      expect(init.error, stderr).toBeUndefined();
      expect(init.result?._meta).toMatchObject({ midTurnSteering: true });
      const session = await request("session/new", {
        cwd: work,
        mcpServers: [],
      });
      expect(session.error, stderr).toBeUndefined();
      const sessionId = session.result!.sessionId;
      const prompt = (text: string) =>
        request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text }],
        });
      const first = prompt("Hold at the gated tool.");
      await waitFile(join(work, "ready"));
      const correction = prompt("USE_CORRECTION");
      const secondCorrection = prompt("SECOND_CORRECTION");
      // Wait for the public durable inbox append before releasing the executing tool.
      const deadline = Date.now() + 10000;
      while (
        !(await readFile(evidence, "utf8")).includes("SECOND_CORRECTION")
      ) {
        if (Date.now() > deadline)
          throw new Error("Steering was not persisted: " + stderr);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await writeFile(join(work, "release"), "");
      expect((await first).result).toEqual({ stopReason: "end_turn" });
      expect((await correction).result).toEqual({ stopReason: "end_turn" });
      expect((await secondCorrection).result).toEqual({
        stopReason: "end_turn",
      });
      expect(await readFile(join(work, "tool-finished"), "utf8")).toBe(
        "finished",
      );
      expect(await readFile(join(work, "result"), "utf8")).toBe("corrected");
      const events = (await readFile(evidence, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        events.filter((event) => event.type === "turn/start"),
      ).toHaveLength(1);
      expect(events.some((event) => event.type === "fixture/review")).toBe(
        true,
      );
      const consumed = events
        .filter((event) => event.type === "fixture/input")
        .at(-1).text;
      expect(consumed).toContain("USE_CORRECTION");
      expect(consumed).toContain("SECOND_CORRECTION");
      expect(consumed.indexOf("USE_CORRECTION")).toBeLessThan(
        consumed.indexOf("SECOND_CORRECTION"),
      );
      await rm(join(work, "ready"));
      await rm(join(work, "release"));
      const cancelled = prompt("Hold again.");
      await waitFile(join(work, "ready"));
      const cancelledSteer = prompt("USE_CORRECTION");
      send("session/cancel", { sessionId });
      expect((await cancelled).result).toEqual({ stopReason: "cancelled" });
      expect((await cancelledSteer).result).toEqual({
        stopReason: "cancelled",
      });
      const toolPid = Number(await readFile(join(work, "tool.pid"), "utf8"));
      expect(Number.isSafeInteger(toolPid) && toolPid > 0).toBe(true);
      expect(() => process.kill(toolPid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
      await writeFile(join(work, "release"), "");
      expect(
        (await prompt("USE_CORRECTION SECOND_CORRECTION after stop")).result,
      ).toEqual({
        stopReason: "end_turn",
      });
    } finally {
      child.stdin.end();
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(kill);
      lines.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
