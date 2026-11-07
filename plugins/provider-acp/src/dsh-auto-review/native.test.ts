import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  access,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { z } from "zod";
import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { withDshAutoReview } from "./bridge.js";

const command = process.env.DSH_NATIVE_TEST_COMMAND;
it.skipIf(!command).each([
  { mode: "allow", approve: false, executed: true, prompts: 0 },
  { mode: "deny", approve: true, executed: true, prompts: 1 },
  { mode: "deny", approve: false, executed: false, prompts: 1 },
  { mode: "failed", approve: false, executed: false, prompts: 0 },
  { mode: "malformed", approve: false, executed: false, prompts: 0 },
  { mode: "full", approve: false, executed: true, prompts: 0 },
])(
  "native DSH $mode approval=$approve executes=$executed",
  async ({ mode, approve, executed, prompts }) => {
    const root = await mkdtemp(join(tmpdir(), "bb-dsh-native-"));
    const work = join(root, "work");
    await mkdir(work);
    const bridge = withDshAutoReview(
      experimental_defineProviderBridge({ handleLine() {} }),
    );
    bridge.start?.({ pluginId: "test", dataDir: root, tempDir: root });
    const patch = join(root, "fixture.yml");
    await writeFile(
      patch,
      JSON.stringify([
        {
          insert: [
            {
              id: "smoke-model",
              name: fileURLToPath(
                new URL("./model-fixture.mjs", import.meta.url),
              ),
            },
          ],
        },
      ]),
    );
    const child = spawn(
      command ?? "dsh",
      [
        "--profile",
        "acp",
        "--patch",
        join(root, "dsh-auto-review.yml"),
        "--patch",
        patch,
      ],
      {
        env: {
          ...process.env,
          DSH_HOME: join(root, "home"),
          DSH_REVIEW_SMOKE_MODE: mode === "full" ? "deny" : mode,
          BB_DSH_PERMISSION_PRESET:
            mode === "full" ? "danger-full-access" : "auto",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    let approvals = 0;
    let allowApproval = approve;
    let nextId = 1;
    const waiting = new Map<
      number,
      { resolve(value: unknown): void; reject(error: Error): void }
    >();
    const send = (value: object) =>
      child.stdin.write(JSON.stringify(value) + "\n");
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const message = z
        .object({
          method: z.string().optional(),
          id: z.union([z.number(), z.string()]).optional(),
          result: z.unknown().optional(),
          error: z.unknown().optional(),
        })
        .parse(JSON.parse(line));
      if (message.method === "session/request_permission") {
        approvals++;
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            outcome: {
              outcome: "selected",
              optionId: allowApproval ? "allow-once" : "reject-once",
            },
          },
        });
      } else if (typeof message.id === "number") {
        const pending = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.error)
          pending?.reject(new Error(JSON.stringify(message.error)));
        else pending?.resolve(message.result);
      }
    });
    child.on("exit", () => {
      for (const pending of waiting.values()) pending.reject(new Error(errors));
      waiting.clear();
    });
    const request = (method: string, params: object) =>
      new Promise<unknown>((resolve, reject) => {
        const id = nextId++;
        waiting.set(id, { resolve, reject });
        send({ jsonrpc: "2.0", id, method, params });
      });
    try {
      await request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      const session = z.object({ sessionId: z.string() }).parse(
        await request("session/new", {
          cwd: work,
          mcpServers: [],
        }),
      );
      await request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [
          {
            type: "text",
            text: "Write marker.txt in the current workspace for this test.",
          },
        ],
      });
      expect(approvals, errors).toBe(prompts);
      const exists = await access(join(work, "marker.txt")).then(
        () => true,
        () => false,
      );
      expect(exists, errors).toBe(executed);
      if (executed)
        expect(await readFile(join(work, "marker.txt"), "utf8")).toBe(
          "reviewed",
        );
      if (mode === "deny" && approve) {
        await request("session/close", { sessionId: session.sessionId });
        await rm(join(work, "marker.txt"));
        allowApproval = false;
        approvals = 0;
        await request("session/resume", {
          sessionId: session.sessionId,
          cwd: work,
          mcpServers: [],
        });
        await request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [
            {
              type: "text",
              text: "Write marker.txt again for the resumed-session test.",
            },
          ],
        });
        expect(approvals).toBe(1);
        expect(
          await access(join(work, "marker.txt")).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
      }
    } finally {
      child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
      lines.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
